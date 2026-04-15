'use strict';
'require view';
'require uci';
'require rpc';
'require fs';
'require ui';
'require poll';

/*
 * luci-app-torrserver — overview.js
 *
 * Современный LuCI View (OpenWrt 23.05+).
 * Не использует CBI, Lua, luci-compat.
 * Управление сервисом — через file.exec (rpcd).
 * Статус  — через ubus service list.
 * Настройки UCI — через uci API LuCI.
 * Лог — через file.exec logread / file.read (если logpath задан).
 */

/* ── rpcd-вызовы ── */

const callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: [ 'name' ],
    expect: { '': {} }
});

const callFileExec = rpc.declare({
    object: 'file',
    method: 'exec',
    params: [ 'command', 'args' ],
    expect: { '': {} }
});

const callFileRead = rpc.declare({
    object: 'file',
    method: 'read',
    params: [ 'path' ],
    expect: { data: '' }
});

/* ── хелперы ── */

function svcAction(action) {
    return callFileExec('/etc/init.d/torrserver', [ action ]);
}

function getPid() {
    return callFileExec('/bin/pidof', [ 'torrserver' ])
        .then(function(r) {
            const out = (r && r.stdout) ? r.stdout.trim().split(/\s+/)[0] : '';
            return out || null;
        });
}

function getMemKb(pid) {
    if (!pid) return Promise.resolve(0);
    return callFileRead('/proc/' + pid + '/status').then(function(r) {
        const m = (r || '').match(/VmRSS:\s+(\d+)/);
        return m ? parseInt(m[1]) : 0;
    });
}

function getSysMem() {
    return callFileRead('/proc/meminfo').then(function(r) {
        const lines = (r || '').split('\n');
        let total = 0, avail = 0, free = 0;
        lines.forEach(function(l) {
            const m = l.match(/^(\w+):\s+(\d+)/);
            if (!m) return;
            if (m[1] === 'MemTotal')     total = parseInt(m[2]);
            if (m[1] === 'MemAvailable') avail = parseInt(m[2]);
            if (m[1] === 'MemFree')      free  = parseInt(m[2]);
        });
        return { total: total, available: avail || free };
    });
}

/*
 * getCpuStat — возвращает { cores: [...%], raw: {cpu0:{total,work},...} }
 * raw передаётся в getProcCpu, чтобы не читать /proc/stat дважды за тик.
 */
let _prevStat = null;

function getCpuStat() {
    return callFileRead('/proc/stat').then(function(r) {
        const lines = (r || '').split('\n');
        const cur = {};
        let cpuCount = 0;
        lines.forEach(function(l) {
            const m = l.match(/^(cpu\d*)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
            if (!m) return;
            const u = +m[2], n = +m[3], s = +m[4], i = +m[5];
            cur[m[1]] = { total: u + n + s + i, work: u + n + s };
            if (m[1] !== 'cpu') cpuCount++;
        });

        /* динамический список ядер из /proc/stat */
        const cores = [];
        for (let i = 0; i < cpuCount; i++) {
            const k = 'cpu' + i;
            let pct = 0;
            if (cur[k] && _prevStat && _prevStat[k]) {
                const dt = cur[k].total - _prevStat[k].total;
                const dw = cur[k].work  - _prevStat[k].work;
                if (dt > 0) pct = Math.round((dw / dt) * 100);
            }
            cores.push(pct);
        }
        _prevStat = cur;
        /* возвращаем и проценты ядер, и сырые данные для getProcCpu */
        return { cores: cores, raw: cur };
    });
}

/*
 * getProcCpu — принимает готовые raw-данные /proc/stat, не делает лишний RPC.
 */
let _prevProcStat = null;

function getProcCpu(pid, rawStat) {
    if (!pid) return Promise.resolve('0');
    return callFileRead('/proc/' + pid + '/stat').then(function(pstatStr) {
        const pstat    = (pstatStr || '').split(/\s+/);
        const utime    = parseInt(pstat[13]) || 0;
        const stime    = parseInt(pstat[14]) || 0;
        const procTotal = utime + stime;

        const cpuAll  = rawStat && rawStat['cpu'];
        const sysTotal = cpuAll ? cpuAll.total : 0;

        /* считаем кол-во ядер из rawStat */
        let cpuCount = 0;
        if (rawStat) {
            Object.keys(rawStat).forEach(function(k) {
                if (/^cpu\d+$/.test(k)) cpuCount++;
            });
        }
        if (cpuCount < 1) cpuCount = 1;

        if (!_prevProcStat) {
            _prevProcStat = { proc: procTotal, sys: sysTotal };
            return '0';
        }
        const dp = procTotal - _prevProcStat.proc;
        const ds = sysTotal  - _prevProcStat.sys;
        _prevProcStat = { proc: procTotal, sys: sysTotal };
        return ds > 0 ? (Math.min((dp / ds) * 100 * cpuCount, 100)).toFixed(1) : '0';
    });
}

function getLog() {
    /* если задан logpath в UCI — читаем файл, иначе logread */
    const logpath = uci.get('torrserver', 'main', 'logpath') || '';
    if (logpath) {
        return callFileRead(logpath).then(function(r) {
            if (!r) return '';
            const lines = r.split('\n');
            return lines.slice(-200).join('\n');
        });
    }
    return callFileExec('/sbin/logread', [ '-e', 'torrserver' ])
        .then(function(r) {
            const out = (r && r.stdout) ? r.stdout : '';
            const lines = out.split('\n');
            return lines.slice(-200).join('\n');
        });
}

function getLanIp() {
    return uci.load('network').then(function() {
        /* пробуем ipaddr напрямую; на bridge-конфигурациях может быть пусто */
        const ip = uci.get('network', 'lan', 'ipaddr');
        return ip || '192.168.1.1';
    });
}

/* ── View ── */

return view.extend({

    _pollTimer: null,

    /* Данные загружаемые при открытии страницы */
    load: function() {
        return Promise.all([
            uci.load('torrserver'),
            getLanIp(),
            callFileExec('/bin/ls', [ '/usr/bin/torrserver' ]),
            callFileExec('/bin/ls', [ '/etc/init.d/torrserver' ])
        ]);
    },

    /* вызывается LuCI при уходе со страницы — останавливаем поллинг */
    remove: function() {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    },

    /* ── рендер ── */
    render: function(data) {
        const self       = this;
        const lanIp      = data[1] || '192.168.1.1';
        const binOk      = data[2] && data[2].code === 0;
        const initOk     = data[3] && data[3].code === 0;
        const port       = uci.get('torrserver', 'main', 'port') || '8090';
        const webUrl     = 'http://' + lanIp + ':' + port;

        /* ── корневой DOM ── */
        const root = E('div', { class: 'ts-root' });

        /* предупреждение */
        if (!binOk || !initOk) {
            root.appendChild(E('div', { class: 'ts-warn' }, [
                E('strong', {}, 'Нужен daemon TorrServer.'),
                E('br'), E('br'),
                E('span', {}, '/usr/bin/torrserver: '),
                E('b', {}, binOk  ? '✓ OK' : '✗ MISSING'),
                E('br'),
                E('span', {}, '/etc/init.d/torrserver: '),
                E('b', {}, initOk ? '✓ OK' : '✗ MISSING')
            ]));
        }

        /* ── карточки мониторинга ── */
        const wrap = E('div', { class: 'ts-wrap' });

        /* карточка: статус + кнопки */
        const statusVal  = E('div',  { id: 'ts-status',  class: 'ts-val' }, '...');
        const pidVal     = E('small',{ id: 'ts-pid',     class: 'ts-pid' }, '');
        const ctrlPanel  = E('div',  { id: 'ts-ctrl',    class: 'ts-ctrl' });
        const openBtn    = E('button', {
            class: 'cbi-button cbi-button-neutral ts-webui-btn',
            click: function() { window.open(webUrl, '_blank'); }
        }, '↗ Web UI');

        wrap.appendChild(E('div', { class: 'ts-card ts-card-status' }, [
            E('div', { class: 'ts-head' }, 'Сервис'),
            statusVal, pidVal, ctrlPanel, openBtn
        ]));

        /* карточка: RAM */
        const memVal     = E('span', { id: 'ts-mem' }, '0');
        const memBar     = E('div',  { id: 'ts-mem-bar', class: 'ts-bar-fill' });
        const memDetails = E('div',  { id: 'ts-mem-det', class: 'ts-sub' }, 'Free: — | Total: —');
        wrap.appendChild(E('div', { class: 'ts-card ts-card-wide' }, [
            E('div', { class: 'ts-head' }, 'RAM'),
            E('div', {}, [ memVal, E('span', { class: 'ts-unit' }, ' MB (TS)') ]),
            E('div', { class: 'ts-bar-bg' }, [ memBar ]),
            memDetails
        ]));

        /* карточка: CPU процесса */
        const cpuVal = E('span', { id: 'ts-cpu' }, '0');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'CPU (TS)'),
            E('div', { class: 'ts-val' }, [ cpuVal, E('span', { class: 'ts-unit' }, '%') ]),
            E('div', { class: 'ts-sub' }, 'нагрузка процесса')
        ]));

        /* карточка: ядра — количество определяется динамически при первом тике */
        const coresWrap = E('div', { id: 'ts-cores-grid', class: 'ts-cores-grid' });
        const coresTxt  = E('div', { id: 'ts-cores-txt',  class: 'ts-sub' }, '...');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'Cores'),
            coresWrap,
            coresTxt
        ]));

        root.appendChild(wrap);

        /* ── лог ── */
        let logVisible = false;
        const logBox = E('div', { id: 'ts-log', class: 'ts-log' }, 'Загрузка...');
        logBox.style.display = 'none';
        const logBtn = E('button', {
            class: 'cbi-button cbi-button-neutral',
            style: 'margin-top:10px',
            click: function() {
                logVisible = !logVisible;
                logBox.style.display = logVisible ? 'block' : 'none';
                logBtn.textContent = logVisible ? '▲ Скрыть лог' : '▼ Показать лог';
                if (logVisible) refreshLog();
            }
        }, '▼ Показать лог');
        root.appendChild(logBtn);
        root.appendChild(logBox);

        /* ── настройки UCI ── */
        root.appendChild(E('hr', { style: 'margin:20px 0;border-color:rgba(255,255,255,.1)' }));
        root.appendChild(self._renderSettings());

        /* ── CSS ── */
        root.insertBefore(self._renderStyles(), root.firstChild);

        /* ── polling ── */
        let pendingAction = null;
        let fastUntil     = 0;
        /* отслеживаем количество ядер между тиками */
        let _renderedCoreCount = 0;

        function delay() {
            return (Date.now() / 1000 < fastUntil) ? 1500 : 4000;
        }

        function colorPct(p) {
            return p > 80 ? '#f44336' : p > 50 ? '#ff9800' : '#4caf50';
        }

        /* строим/перестраиваем колонки ядер только если их количество изменилось */
        function ensureCoreColumns(count) {
            if (count === _renderedCoreCount) return;
            _renderedCoreCount = count;
            while (coresWrap.firstChild) coresWrap.removeChild(coresWrap.firstChild);
            for (let i = 0; i < count; i++) {
                coresWrap.appendChild(E('div', { class: 'ts-core-col' }, [
                    E('div', { class: 'ts-core-track' }, [
                        E('div', { id: 'ts-c' + i, class: 'ts-core-fill' })
                    ]),
                    E('div', { class: 'ts-core-num' }, String(i))
                ]));
            }
        }

        function setBar(id, pct) {
            const e = document.getElementById(id);
            if (!e) return;
            const h = Math.min(Math.max(Math.round(pct), 0), 100);
            e.style.height = h + '%';
            e.style.backgroundColor = colorPct(h);
        }

        function renderCtrl(running, canCtrl) {
            const p = document.getElementById('ts-ctrl');
            if (!p) return;
            while (p.firstChild) p.removeChild(p.firstChild);

            if (!canCtrl) {
                p.appendChild(E('button', {
                    class: 'cbi-button ts-btn-disabled', disabled: true
                }, 'daemon missing'));
                return;
            }

            function mkBtn(label, cls, action) {
                return E('button', {
                    class: 'cbi-button ts-btn-' + cls,
                    click: function() {
                        pendingAction = action;
                        fastUntil = Date.now() / 1000 + 15;
                        this.textContent = label === 'Start'   ? 'Starting...'
                                         : label === 'Stop'    ? 'Stopping...'
                                         :                        'Restarting...';
                        this.disabled = true;
                        svcAction(action).then(function() {
                            setTimeout(tick, 800);
                            setTimeout(tick, 1800);
                            setTimeout(tick, 3000);
                        });
                    }
                }, label);
            }

            if (running) {
                p.appendChild(mkBtn('Stop',    'stop',    'stop'));
                p.appendChild(mkBtn('Restart', 'restart', 'restart'));
            } else {
                p.appendChild(mkBtn('Start', 'start', 'start'));
            }
        }

        function tick() {
            Promise.all([
                callServiceList('torrserver'),
                getSysMem(),
                getCpuStat(),   /* возвращает { cores, raw } */
            ]).then(function(res) {
                const svcData  = res[0];
                const sysMem   = res[1];
                const cpuData  = res[2];    /* { cores: [...], raw: {...} } */
                const cores    = cpuData.cores;
                const rawStat  = cpuData.raw;

                /* статус через procd service list */
                const inst = svcData && svcData.torrserver
                                && svcData.torrserver.instances;
                const running = inst
                                ? Object.values(inst).some(function(i) { return i.running; })
                                : false;
                const pidFromSvc = inst
                                ? (Object.values(inst)[0] || {}).pid || null
                                : null;
                const pid = pidFromSvc ? String(pidFromSvc) : null;

                const st    = document.getElementById('ts-status');
                const pEl   = document.getElementById('ts-pid');
                const canCtrl = binOk && initOk;

                if (!canCtrl) {
                    if (st) st.innerHTML = '<span style="color:#ffb74d">NO DAEMON</span>';
                    renderCtrl(false, false);
                    return;
                }

                if (running) {
                    if (st) st.innerHTML = '<span style="color:#4caf50">ЗАПУЩЕН</span>';
                    if (pEl) pEl.textContent = pid ? 'PID ' + pid : '';
                    if (pendingAction === 'start' || pendingAction === 'restart') pendingAction = null;
                } else {
                    if (pendingAction === 'stop') {
                        if (st) st.innerHTML = '<span style="color:#ff9800">STOPPING...</span>';
                    } else if (pendingAction) {
                        if (st) st.innerHTML = '<span style="color:#ff9800">STARTING...</span>';
                    } else {
                        if (st) st.innerHTML = '<span style="color:#f44336">ОСТАНОВЛЕН</span>';
                        if (pEl) pEl.textContent = '';
                    }
                    if (pendingAction === 'stop') pendingAction = null;
                }

                renderCtrl(running, canCtrl);

                /* RAM */
                getMemKb(pid).then(function(kb) {
                    const memEl = document.getElementById('ts-mem');
                    const barEl = document.getElementById('ts-mem-bar');
                    const detEl = document.getElementById('ts-mem-det');
                    if (memEl) memEl.textContent = running ? (kb / 1024).toFixed(1) : '0';
                    if (detEl && sysMem.total > 0) {
                        detEl.textContent =
                            'Free: '  + (sysMem.available / 1024).toFixed(0) +
                            ' MB | Total: ' + (sysMem.total / 1024).toFixed(0) + ' MB';
                    }
                    if (barEl) {
                        barEl.style.width = (running && sysMem.total > 0)
                            ? Math.max((kb / sysMem.total) * 100, 1) + '%'
                            : '0%';
                    }
                });

                /* CPU процесса — передаём rawStat, избегаем второго чтения /proc/stat */
                getProcCpu(pid, rawStat).then(function(pct) {
                    const el = document.getElementById('ts-cpu');
                    if (el) el.textContent = running ? pct : '0';
                });

                /* ядра — динамически */
                ensureCoreColumns(cores.length);
                const txt = cores.map(function(v, i) {
                    setBar('ts-c' + i, v);
                    return Math.round(v) + '%';
                });
                const ct = document.getElementById('ts-cores-txt');
                if (ct) ct.textContent = cores.length ? txt.join(' | ') : '—';
            });
        }

        function refreshLog() {
            getLog().then(function(text) {
                const el = document.getElementById('ts-log');
                if (!el) return;
                el.textContent = text || 'Лог пуст.';
                el.scrollTop = el.scrollHeight;
            });
        }

        function schedulePoll() {
            self._pollTimer = setTimeout(function() {
                tick();
                schedulePoll();
            }, delay());
        }

        tick();
        schedulePoll();

        return root;
    },

    /* ── UCI настройки ── */
    _renderSettings: function() {
        const self = this;
        const wrap = E('div', { class: 'ts-settings' });

        function row(label, el) {
            return E('div', { class: 'ts-row' }, [
                E('label', { class: 'ts-label' }, label),
                E('div',   { class: 'ts-field' }, [ el ])
            ]);
        }

        function inp(opt, placeholder, type, min, max) {
            const val = uci.get('torrserver', 'main', opt) || '';
            const attrs = {
                class: 'cbi-input-text',
                type: type || 'text',
                value: val,
                placeholder: placeholder || '',
                input: function() { uci.set('torrserver', 'main', opt, this.value); }
            };
            if (min !== undefined) attrs.min = String(min);
            if (max !== undefined) attrs.max = String(max);
            return E('input', attrs);
        }

        function chk(opt, def) {
            const val = uci.get('torrserver', 'main', opt);
            const checked = (val !== undefined) ? (val === '1') : (def === '1');
            return E('input', {
                type: 'checkbox',
                checked: checked,
                class: 'ts-chk',
                change: function() { uci.set('torrserver', 'main', opt, this.checked ? '1' : '0'); }
            });
        }

        function sel(opt, options, def) {
            const cur = uci.get('torrserver', 'main', opt) || def;
            return E('select', {
                class: 'cbi-input-select',
                change: function() { uci.set('torrserver', 'main', opt, this.value); }
            }, options.map(function(o) {
                return E('option', { value: o, selected: o === cur }, o);
            }));
        }

        /* ── Основные ── */
        wrap.appendChild(E('h3', { class: 'ts-section-title' }, 'Основные настройки'));
        wrap.appendChild(row('Автозапуск',           chk('enabled', '1')));
        /* порт: number с валидацией диапазона 1–65535 */
        wrap.appendChild(row('Порт',                  inp('port', '8090', 'number', 1, 65535)));
        wrap.appendChild(row('Рабочая директория',     inp('path', '/opt/torrserver')));
        wrap.appendChild(row('Режим прокси',           sel('proxymode', ['tracker','all','off'], 'tracker')));

        /* ── Дополнительные ── */
        const advTitle = E('h3', {
            class: 'ts-section-title ts-adv-toggle',
            style: 'cursor:pointer',
            click: function() {
                advBody.style.display = advBody.style.display === 'none' ? '' : 'none';
                this.textContent = advBody.style.display === 'none'
                    ? '▶ Дополнительные настройки'
                    : '▼ Дополнительные настройки';
            }
        }, '▶ Дополнительные настройки');

        const advBody = E('div', { style: 'display:none' });
        advBody.appendChild(row('IP для bind',                      inp('ip', '0.0.0.0')));
        advBody.appendChild(row('--dontkill',                       chk('dontkill', '1')));
        advBody.appendChild(row('HTTP auth',                        chk('httpauth', '0')));
        advBody.appendChild(row('RDB режим',                        chk('rdb', '0')));
        advBody.appendChild(row('Путь к логу',                      inp('logpath', '/tmp/torrserver.log')));
        advBody.appendChild(row('Путь к web-логу',                  inp('weblogpath', '/tmp/torrserver-web.log')));
        advBody.appendChild(row('Каталог torrents',                  inp('torrentsdir', '/opt/torrserver/torrents')));
        advBody.appendChild(row('Torrent listen addr',               inp('torrentaddr', 'example.com:6881')));
        advBody.appendChild(row('Публичный IPv4',                   inp('pubipv4', '')));
        advBody.appendChild(row('Публичный IPv6',                   inp('pubipv6', '')));
        advBody.appendChild(row('Web/API поиск',                    chk('searchwa', '0')));
        advBody.appendChild(row('Макс. размер',                     inp('maxsize', '64M')));
        advBody.appendChild(row('Telegram',                         inp('tg', '')));
        advBody.appendChild(row('FUSE',                             inp('fuse', '')));
        advBody.appendChild(row('WebDAV',                           chk('webdav', '0')));
        advBody.appendChild(row('Proxy URL',                        inp('proxyurl', 'http://127.0.0.1:8080')));

        wrap.appendChild(advTitle);
        wrap.appendChild(advBody);

        /* ── кнопки сохранения ── */
        wrap.appendChild(E('div', { class: 'ts-save-row' }, [
            E('button', {
                class: 'cbi-button cbi-button-apply',
                click: function() {
                    uci.save().then(function() {
                        /* true = без rollback-confirm */
                        return uci.apply(true);
                    }).then(function() {
                        ui.addNotification(null, E('p', {}, 'Настройки применены.'), 'info');
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + e.message), 'danger');
                    });
                }
            }, 'Применить'),
            E('button', {
                class: 'cbi-button cbi-button-save',
                click: function() {
                    uci.save().then(function() {
                        ui.addNotification(null, E('p', {}, 'Настройки сохранены (без применения).'), 'info');
                    });
                }
            }, 'Сохранить'),
            E('button', {
                class: 'cbi-button cbi-button-reset',
                click: function() {
                    uci.unload('torrserver');
                    uci.load('torrserver').then(function() {
                        ui.addNotification(null, E('p', {}, 'Сброшено до сохранённых значений.'), 'info');
                        /* self захвачен в начале _renderSettings */
                        const r = document.querySelector('.ts-settings');
                        if (r) r.replaceWith(self._renderSettings());
                    });
                }
            }, 'Сбросить')
        ]));

        return wrap;
    },

    /* ── стили ── */
    _renderStyles: function() {
        return E('style', {}, [`
            .ts-root { font-size: 14px; }
            .ts-warn {
                margin: 0 0 16px;
                padding: 12px 14px;
                border-radius: 8px;
                border: 1px solid rgba(255,180,0,.45);
                background: rgba(255,180,0,.10);
                color: var(--text-color-high, #f5f5f5);
            }
            .ts-wrap {
                display: flex;
                flex-wrap: wrap;
                gap: 14px;
                margin-bottom: 18px;
                align-items: stretch;
            }
            .ts-card {
                background: var(--background-color-medium, rgba(255,255,255,.04));
                border: 1px solid var(--border-color-medium, rgba(255,255,255,.10));
                border-radius: 10px;
                padding: 12px;
                width: 180px;
                text-align: center;
                display: flex;
                flex-direction: column;
                justify-content: space-between;
                color: var(--text-color-high, #f5f5f5);
                box-sizing: border-box;
            }
            .ts-card-wide  { width: 240px; }
            .ts-card-status { min-height: 160px; }
            .ts-head {
                font-size: 10px;
                color: var(--text-color-medium, #aaa);
                text-transform: uppercase;
                margin-bottom: 8px;
                font-weight: 600;
            }
            .ts-val {
                font-size: 22px;
                font-weight: bold;
                color: var(--text-color-high, #f5f5f5);
                line-height: 1.2;
            }
            .ts-unit  { font-size: 12px; color: var(--text-color-medium, #aaa); }
            .ts-sub   { font-size: 11px; color: var(--text-color-medium, #aaa); margin-top: 4px; }
            .ts-pid   { font-size: 10px; color: var(--text-color-medium, #aaa); font-family: monospace; margin-top: 2px; }
            .ts-bar-bg   { background: rgba(255,255,255,.08); height: 6px; border-radius: 3px; overflow: hidden; margin: 8px 0 4px; }
            .ts-bar-fill { background: #2196F3; height: 100%; width: 0%; transition: width .5s ease-in-out; }
            .ts-cores-grid {
                display: flex;
                gap: 6px;
                height: 70px;
                align-items: flex-end;
                justify-content: center;
                margin-top: 5px;
            }
            .ts-core-col  { width: 22px; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
            .ts-core-track {
                width: 100%; height: 55px;
                background: rgba(255,255,255,.06);
                border-radius: 3px; overflow: hidden;
                border: 1px solid rgba(255,255,255,.08);
                display: flex; flex-direction: column-reverse;
            }
            .ts-core-fill  { width: 100%; background: #4caf50; height: 0%; transition: height .4s ease-out; }
            .ts-core-num   { font-size: 9px; color: var(--text-color-medium,#aaa); margin-top: 3px; }
            .ts-ctrl { margin-top: 10px; display: flex; gap: 6px; justify-content: center; }
            .ts-btn-start   { background: #4caf50 !important; color: #fff !important; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 11px; }
            .ts-btn-stop    { background: #f44336 !important; color: #fff !important; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 11px; }
            .ts-btn-restart { background: #ff9800 !important; color: #fff !important; border: none; border-radius: 4px; padding: 5px 10px; cursor: pointer; font-size: 11px; }
            .ts-btn-disabled { background: #555 !important; color: #aaa !important; border: none; border-radius: 4px; padding: 5px 10px; cursor: not-allowed; font-size: 11px; }
            .ts-webui-btn { margin-top: 8px; width: 100%; font-size: 11px; }
            .ts-log {
                width: 100%;
                box-sizing: border-box;
                background: rgba(0,0,0,.4);
                color: #f8f8f2;
                border-radius: 8px;
                padding: 10px;
                font-family: monospace;
                font-size: 11px;
                height: 260px;
                overflow-y: auto;
                white-space: pre-wrap;
                border: 1px solid rgba(255,255,255,.08);
                margin-top: 8px;
            }
            .ts-settings { margin-top: 4px; }
            .ts-section-title {
                font-size: 13px;
                font-weight: 600;
                color: var(--text-color-high, #f5f5f5);
                margin: 16px 0 8px;
                border-bottom: 1px solid rgba(255,255,255,.08);
                padding-bottom: 4px;
            }
            .ts-row {
                display: flex;
                align-items: center;
                gap: 10px;
                margin-bottom: 8px;
            }
            .ts-label {
                width: 220px;
                flex-shrink: 0;
                font-size: 13px;
                color: var(--text-color-high, #f5f5f5);
            }
            .ts-field { flex: 1; }
            .ts-field input[type=text],
            .ts-field input[type=number],
            .ts-field select {
                width: 100%;
                max-width: 320px;
                box-sizing: border-box;
            }
            .ts-chk { width: 16px; height: 16px; cursor: pointer; }
            .ts-save-row { margin-top: 16px; display: flex; gap: 8px; }
        `]);
    },

    handleSaveApply: null,
    handleSave:      null,
    handleReset:     null
});
