'use strict';
'require view';
'require uci';
'require rpc';
'require fs';
'require ui';
'require poll';

/*
 * luci-app-torrserver — overview.js  v6
 *
 * Fixes vs v5:
 * - system.info memory: байты → МБ (/ 1048576)
 * - getProcessList: expect { '': {} } — парсим procRaw.processes || procRaw.result || []
 * - RSS из getProcessList в КБ → МБ (/ 1024), бар = rss_bytes / mem.total
 * - getCpuCores: file.exec /bin/cat /proc/stat (file.read заблокирован для /proc)
 * - getLog: logread -e torrserver через file.exec (ubus log.read не фильтрует по тегу)
 */

/* ── rpc declarations ── */

const callServiceList = rpc.declare({
    object: 'service',
    method: 'list',
    params: ['name'],
    expect: { '': {} }
});

const callSystemInfo = rpc.declare({
    object: 'system',
    method: 'info',
    expect: { '': {} }
});

/* expect { '': {} } — берём весь объект, структура может быть { processes: [] } */
const callProcessList = rpc.declare({
    object: 'luci',
    method: 'getProcessList',
    expect: { '': {} }
});

const callInitAction = rpc.declare({
    object: 'luci',
    method: 'setInitAction',
    params: ['name', 'action'],
    expect: { result: false }
});

const callFileExec = rpc.declare({
    object: 'file',
    method: 'exec',
    params: ['command', 'args', 'env'],
    expect: { '': {} }
});

/* ── helpers ── */

function svcAction(action) {
    return callInitAction('torrserver', action).then(function(ok) {
        if (ok) return true;
        return callFileExec('/bin/sh',
            ['-c', '/etc/init.d/torrserver ' + action + ' >/dev/null 2>&1'], {});
    }).catch(function() {
        return callFileExec('/bin/sh',
            ['-c', '/etc/init.d/torrserver ' + action + ' >/dev/null 2>&1'], {});
    });
}

/* per-core CPU через file.exec /bin/cat /proc/stat
   file.read для /proc заблокирован политикой rpcd на OpenWrt 24+ */
let _prevCoreStat = null;
function getCpuCores() {
    return callFileExec('/bin/cat', ['/proc/stat'], {}).then(function(r) {
        const out = (r && r.stdout) ? r.stdout : '';
        const cur = {};
        out.split('\n').forEach(function(l) {
            const m = l.match(/^(cpu\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
            if (!m) return;
            const u=+m[2], n=+m[3], s=+m[4], i=+m[5];
            cur[m[1]] = { total: u+n+s+i, work: u+n+s };
        });
        const cores = [0,0,0,0];
        for (let i = 0; i < 4; i++) {
            const k = 'cpu'+i;
            if (cur[k] && _prevCoreStat && _prevCoreStat[k]) {
                const dt = cur[k].total - _prevCoreStat[k].total;
                const dw = cur[k].work  - _prevCoreStat[k].work;
                if (dt > 0) cores[i] = Math.round((dw/dt)*100);
            }
        }
        _prevCoreStat = cur;
        return cores;
    }).catch(function() { return [0,0,0,0]; });
}

/* лог через logread -e torrserver
   ubus log.read не фильтрует по тегу демона на этой сборке */
function getLog() {
    return callFileExec('/sbin/logread', ['-e', 'torrserver'], {}).then(function(r) {
        const out = (r && r.stdout) ? r.stdout
                  : (r && r.stderr) ? r.stderr   /* busybox logread иногда пишет в stderr */
                  : '';
        if (!out.trim())
            return 'Нет событий torrserver в логе.';
        return out.trim().split('\n').slice(-200).join('\n');
    }).catch(function(e) {
        return '[error] logread: ' + String(e);
    });
}

/* ── View ── */
return view.extend({

    load: function() {
        return Promise.all([
            uci.load('torrserver'),
            uci.load('network'),
            fs.stat('/usr/bin/torrserver'),
            fs.stat('/etc/init.d/torrserver')
        ]);
    },

    render: function(data) {
        const binOk   = data[2] != null;
        const initOk  = data[3] != null;
        const lanIp   = uci.get('network', 'lan', 'ipaddr') || '192.168.1.1';
        const port    = uci.get('torrserver', 'main', 'port') || '8090';
        const webUrl  = 'http://' + lanIp + ':' + port;
        const canCtrl = binOk && initOk;

        const root = E('div', { class: 'ts-root' });
        root.appendChild(this._renderStyles());

        if (!binOk || !initOk) {
            root.appendChild(E('div', { class: 'ts-warn' }, [
                E('strong', {}, 'Нужен daemon TorrServer.'), E('br'), E('br'),
                E('span', {}, '/usr/bin/torrserver: '),
                E('b', { style: binOk  ? 'color:#4caf50' : 'color:#f44336' }, binOk  ? '✓ OK' : '✗ MISSING'),
                E('br'),
                E('span', {}, '/etc/init.d/torrserver: '),
                E('b', { style: initOk ? 'color:#4caf50' : 'color:#f44336' }, initOk ? '✓ OK' : '✗ MISSING')
            ]));
        }

        /* ── карточки ── */
        const wrap = E('div', { class: 'ts-wrap' });

        const statusEl = E('div',   { id: 'ts-status', class: 'ts-val' }, '...');
        const pidEl    = E('small', { id: 'ts-pid',    class: 'ts-pid' }, '');
        const ctrlEl   = E('div',   { id: 'ts-ctrl',   class: 'ts-ctrl' });
        wrap.appendChild(E('div', { class: 'ts-card ts-card-status' }, [
            E('div', { class: 'ts-head' }, 'СЕРВИС'), statusEl, pidEl, ctrlEl
        ]));

        const memEl = E('span', { id: 'ts-mem' }, '0.0');
        const barEl = E('div',  { id: 'ts-mem-bar', class: 'ts-bar-fill' });
        const detEl = E('div',  { id: 'ts-mem-det', class: 'ts-sub' }, 'Free: — | Total: —');
        wrap.appendChild(E('div', { class: 'ts-card ts-card-wide' }, [
            E('div', { class: 'ts-head' }, 'RAM'),
            E('div', {}, [memEl, E('span', { class: 'ts-unit' }, ' MB (TS)')]),
            E('div', { class: 'ts-bar-bg' }, [barEl]),
            detEl
        ]));

        const cpuEl = E('span', { id: 'ts-cpu' }, '0.0');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'CPU (TS)'),
            E('div', { class: 'ts-val' }, [cpuEl, E('span', { class: 'ts-unit' }, '%')]),
            E('div', { class: 'ts-sub' }, 'нагрузка процесса')
        ]));

        const coreEls = [0,1,2,3].map(function(i) {
            return E('div', { class: 'ts-core-col' }, [
                E('div', { class: 'ts-core-track' }, [E('div', { id: 'ts-c'+i, class: 'ts-core-fill' })]),
                E('div', { class: 'ts-core-num' }, String(i))
            ]);
        });
        const coresTxtEl = E('div', { id: 'ts-cores-txt', class: 'ts-sub' }, '0%|0%|0%|0%');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'CORES'),
            E('div', { class: 'ts-cores-grid' }, coreEls),
            coresTxtEl
        ]));

        root.appendChild(wrap);

        /* ── лог ── */
        let logVisible = false;
        const logBox = E('pre', { id: 'ts-log', class: 'ts-log' });
        logBox.style.display = 'none';

        function doRefreshLog() {
            logBox.textContent = 'Загрузка...';
            getLog().then(function(text) {
                logBox.textContent = text;
                logBox.scrollTop = logBox.scrollHeight;
            });
        }

        const logBtn = E('button', {
            class: 'cbi-button cbi-button-neutral',
            click: function() {
                logVisible = !logVisible;
                logBox.style.display     = logVisible ? 'block' : 'none';
                logBtn.textContent       = logVisible ? '▲ Скрыть лог' : '▼ Показать лог';
                refreshBtn.style.display = logVisible ? '' : 'none';
                copyBtn.style.display    = logVisible ? '' : 'none';
                if (logVisible) doRefreshLog();
            }
        }, '▼ Показать лог');

        const refreshBtn = E('button', {
            class: 'cbi-button cbi-button-neutral', style: 'display:none',
            click: function() { doRefreshLog(); }
        }, '↻ Обновить лог');

        const copyBtn = E('button', {
            class: 'cbi-button cbi-button-neutral', style: 'display:none',
            click: function() {
                if (!navigator.clipboard) return;
                navigator.clipboard.writeText(logBox.textContent).then(function() {
                    const orig = copyBtn.textContent;
                    copyBtn.textContent = '✓ Скопировано';
                    setTimeout(function() { copyBtn.textContent = orig; }, 1500);
                });
            }
        }, '⎘ Копировать лог');

        root.appendChild(E('div', { class: 'ts-log-bar' }, [logBtn, refreshBtn, copyBtn]));
        root.appendChild(logBox);

        /* ── Web UI + настройки ── */
        root.appendChild(E('hr', { class: 'ts-hr' }));
        root.appendChild(E('div', { style: 'margin-bottom:12px' }, [
            E('button', {
                class: 'cbi-button cbi-button-neutral',
                click: function() { window.open(webUrl, '_blank'); }
            }, '↗ Открыть TorrServer Web UI  (' + webUrl + ')')
        ]));
        root.appendChild(this._renderSettings());

        /* ── state ── */
        let pendingAction = null;
        let prevPid       = null;
        let lastState     = null;

        function colorPct(p) { return p > 80 ? '#f44336' : p > 50 ? '#ff9800' : '#4caf50'; }

        function renderCtrl(running) {
            const p = document.getElementById('ts-ctrl'); if (!p) return;

            if (!canCtrl) {
                if (lastState !== 'no-daemon') {
                    lastState = 'no-daemon'; p.innerHTML = '';
                    p.appendChild(E('button', {
                        class: 'cbi-button ts-btn-disabled', disabled: true
                    }, 'daemon missing'));
                }
                return;
            }

            const newState = running ? 'running' : 'stopped';
            if (pendingAction)        return;
            if (lastState === newState) return;
            lastState = newState;
            p.innerHTML = '';

            function mkBtn(label, cls, action) {
                const btn = E('button', {
                    class: 'cbi-button ts-btn-' + cls,
                    click: function() {
                        if (pendingAction) return;
                        pendingAction = action;
                        const pEl2 = document.getElementById('ts-pid');
                        prevPid = pEl2 ? (pEl2.textContent.match(/\d+/) || [null])[0] : null;
                        btn.textContent = action === 'start'   ? 'Starting...' :
                                          action === 'stop'    ? 'Stopping...' : 'Restarting...';
                        btn.disabled = true;
                        btn.classList.add('ts-btn-busy');
                        poll.start(1.5);
                        svcAction(action).catch(function(e) {
                            console.error('[ts] svcAction', action, e);
                            pendingAction = null; lastState = null;
                        });
                        setTimeout(function() {
                            if (!pendingAction) poll.start(5);
                        }, 20000);
                    }
                }, label);
                return btn;
            }

            if (running) {
                p.appendChild(mkBtn('Stop',    'stop',    'stop'));
                p.appendChild(mkBtn('Restart', 'restart', 'restart'));
            } else {
                p.appendChild(mkBtn('Start', 'start', 'start'));
            }
        }

        /* ── главный tick ── */
        function doTick() {
            return Promise.all([
                callServiceList('torrserver'),
                callSystemInfo(),
                callProcessList()
            ]).then(function(res) {
                const svcData = res[0];
                const sysInfo = res[1];
                const procRaw = res[2];

                /* getProcessList может вернуть:
                   - массив напрямую []
                   - { processes: [] }
                   - { result: [] }  */
                let procArr = [];
                if (Array.isArray(procRaw))
                    procArr = procRaw;
                else if (procRaw && Array.isArray(procRaw.processes))
                    procArr = procRaw.processes;
                else if (procRaw && Array.isArray(procRaw.result))
                    procArr = procRaw.result;

                /* service list → running + pid */
                const inst    = svcData && svcData.torrserver && svcData.torrserver.instances;
                const running = inst
                    ? Object.values(inst).some(function(i) { return i.running; })
                    : false;
                const pidRaw  = inst
                    ? ((Object.values(inst)[0] || {}).pid || null)
                    : null;
                const pid = pidRaw ? String(pidRaw) : null;

                /* сброс pendingAction */
                if (pendingAction === 'stop'    && !running)
                    { pendingAction = null; lastState = null; prevPid = null; poll.start(5); }
                if (pendingAction === 'start'   &&  running)
                    { pendingAction = null; lastState = null; prevPid = null; poll.start(5); }
                if (pendingAction === 'restart' &&  running && pid && pid !== prevPid)
                    { pendingAction = null; lastState = null; prevPid = null; poll.start(5); }

                /* статус */
                const st  = document.getElementById('ts-status');
                const pEl = document.getElementById('ts-pid');

                if (!canCtrl) {
                    if (st) st.innerHTML = '<span style="color:#ffb74d">NO DAEMON</span>';
                    renderCtrl(false); return;
                }
                if (running) {
                    if (st)  st.innerHTML = '<span style="color:#4caf50">ЗАПУЩЕН</span>';
                    if (pEl) pEl.textContent = pid ? 'PID ' + pid : '';
                } else {
                    if (pEl) pEl.textContent = '';
                    if (st) {
                        if      (pendingAction === 'stop')    st.innerHTML = '<span style="color:#ff9800">STOPPING...</span>';
                        else if (pendingAction === 'restart') st.innerHTML = '<span style="color:#ff9800">RESTARTING...</span>';
                        else if (pendingAction === 'start')   st.innerHTML = '<span style="color:#ff9800">STARTING...</span>';
                        else                                  st.innerHTML = '<span style="color:#f44336">ОСТАНОВЛЕН</span>';
                    }
                }
                renderCtrl(running);

                /* ── метрики ── */
                const mem    = sysInfo && sysInfo.memory ? sysInfo.memory : null;
                const tsProc = procArr.find(function(p) {
                    return (p.COMMAND || p.command || '').toLowerCase().indexOf('torrserver') !== -1;
                });

                /* системная RAM: system.info отдаёт байты → МБ */
                const dEl = document.getElementById('ts-mem-det');
                if (mem && mem.total) {
                    const freeMb  = Math.round((mem.free || 0) / 1048576);
                    const totalMb = Math.round(mem.total       / 1048576);
                    if (dEl) dEl.textContent = 'Free: ' + freeMb + ' MB | Total: ' + totalMb + ' MB';
                }

                const mEl = document.getElementById('ts-mem');
                const bEl = document.getElementById('ts-mem-bar');
                const cEl = document.getElementById('ts-cpu');

                if (tsProc && running) {
                    /* getProcessList отдаёт RSS в КБ → МБ */
                    const rssKb  = parseInt(tsProc.RSS || tsProc.rss || 0);
                    const cpuPct = parseFloat(tsProc['%CPU'] || tsProc.cpu || 0);
                    if (mEl) mEl.textContent = (rssKb / 1024).toFixed(1);
                    if (cEl) cEl.textContent = cpuPct.toFixed(1);
                    if (bEl && mem && mem.total) {
                        /* rssKb * 1024 = байты; mem.total в байтах */
                        const pct = Math.max((rssKb * 1024 / mem.total) * 100, 1);
                        bEl.style.width = pct + '%';
                        bEl.style.backgroundColor = colorPct(pct);
                    }
                } else {
                    if (mEl) mEl.textContent = '0.0';
                    if (cEl) cEl.textContent = '0.0';
                    if (bEl) { bEl.style.width = '0%'; bEl.style.backgroundColor = '#2196F3'; }
                }

                /* per-core CPU — отдельный вызов не блокирует основные метрики */
                getCpuCores().then(function(cores) {
                    const ctEl = document.getElementById('ts-cores-txt');
                    const labels = cores.map(function(v, i) {
                        const e = document.getElementById('ts-c' + i);
                        if (e) {
                            const h = Math.min(Math.max(v, 0), 100);
                            e.style.height = h + '%';
                            e.style.backgroundColor = colorPct(h);
                        }
                        return Math.round(v) + '%';
                    });
                    if (ctEl) ctEl.textContent = labels.join(' | ');
                });

            }).catch(function(e) {
                console.error('[ts] doTick:', e);
            });
        }

        poll.add(doTick, 5);
        return root;
    },

    /* ── UCI настройки ── */
    _renderSettings: function() {
        const wrap = E('div', { class: 'ts-settings' });

        function row(label, field) {
            return E('div', { class: 'ts-row' }, [
                E('label', { class: 'ts-label' }, label),
                E('div',   { class: 'ts-field' }, [field])
            ]);
        }
        function inp(opt, ph, type) {
            const v = uci.get('torrserver', 'main', opt) || '';
            return E('input', {
                class: 'cbi-input-text', type: type || 'text',
                value: v, placeholder: ph || '',
                input: function() { uci.set('torrserver', 'main', opt, this.value); }
            });
        }
        function chk(opt, def) {
            const raw     = uci.get('torrserver', 'main', opt);
            const checked = raw != null ? raw === '1' : def === '1';
            const attrs   = { type: 'checkbox', class: 'ts-chk',
                change: function() { uci.set('torrserver', 'main', opt, this.checked ? '1' : '0'); }
            };
            if (checked) attrs.checked = 'checked';
            return E('input', attrs);
        }
        function sel(opt, opts, def) {
            const cur = uci.get('torrserver', 'main', opt) || def;
            return E('select', {
                class: 'cbi-input-select',
                change: function() { uci.set('torrserver', 'main', opt, this.value); }
            }, opts.map(function(o) {
                const a = { value: o }; if (o === cur) a.selected = 'selected';
                return E('option', a, o);
            }));
        }

        wrap.appendChild(E('h3', { class: 'ts-section-title' }, 'Основные настройки'));
        wrap.appendChild(row('Автозапуск',         chk('enabled',   '1')));
        wrap.appendChild(row('Порт',               inp('port',      '8090', 'number')));
        wrap.appendChild(row('Рабочая директория', inp('path',      '/opt/torrserver')));
        wrap.appendChild(row('Режим прокси',       sel('proxymode', ['tracker','all','off'], 'tracker')));

        const advBody = E('div', { style: 'display:none' });
        [
            ['IP для bind',         'ip',          '0.0.0.0',                 'inp'],
            ['--dontkill',          'dontkill',    '1',                       'chk'],
            ['HTTP auth',           'httpauth',    '0',                       'chk'],
            ['RDB режим',           'rdb',         '0',                       'chk'],
            ['Путь к логу',         'logpath',     '/tmp/torrserver.log',     'inp'],
            ['Путь к web-логу',     'weblogpath',  '/tmp/torrserver-web.log', 'inp'],
            ['Каталог torrents',    'torrentsdir', '/opt/torrserver/torrents','inp'],
            ['Torrent listen addr', 'torrentaddr', 'example.com:6881',        'inp'],
            ['Публичный IPv4',      'pubipv4',     '',                        'inp'],
            ['Публичный IPv6',      'pubipv6',     '',                        'inp'],
            ['Web/API поиск',       'searchwa',    '0',                       'chk'],
            ['Макс. размер',        'maxsize',     '64M',                     'inp'],
            ['Telegram',            'tg',          '',                        'inp'],
            ['FUSE',                'fuse',        '',                        'inp'],
            ['WebDAV',              'webdav',      '0',                       'chk'],
            ['Proxy URL',           'proxyurl',    'http://127.0.0.1:8080',  'inp']
        ].forEach(function(r) {
            advBody.appendChild(row(r[0], r[3] === 'chk' ? chk(r[1], r[2]) : inp(r[1], r[2])));
        });

        let advOpen = false;
        const advTitle = E('h3', {
            class: 'ts-section-title', style: 'cursor:pointer;user-select:none',
            click: function() {
                advOpen = !advOpen;
                advBody.style.display = advOpen ? '' : 'none';
                advTitle.textContent  = (advOpen ? '▼' : '▶') + ' Дополнительные настройки';
            }
        }, '▶ Дополнительные настройки');

        wrap.appendChild(advTitle);
        wrap.appendChild(advBody);
        wrap.appendChild(E('div', { class: 'ts-save-row' }, [
            E('button', {
                class: 'cbi-button cbi-button-apply',
                click: function() {
                    uci.save().then(function() { return uci.apply(); })
                    .then(function() {
                        ui.addNotification(null, E('p', {}, 'Настройки применены.'), 'info');
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + e), 'danger');
                    });
                }
            }, 'Применить'),
            E('button', {
                class: 'cbi-button cbi-button-save',
                click: function() {
                    uci.save().then(function() {
                        ui.addNotification(null, E('p', {}, 'Сохранено без применения.'), 'info');
                    });
                }
            }, 'Сохранить'),
            E('button', {
                class: 'cbi-button cbi-button-reset',
                click: function() {
                    uci.unload('torrserver');
                    uci.load('torrserver').then(function() {
                        ui.addNotification(null, E('p', {}, 'Сброшено.'), 'info');
                    });
                }
            }, 'Сбросить')
        ]));

        return wrap;
    },

    _renderStyles: function() {
        return E('style', {}, [`
            .ts-root{font-size:14px}
            .ts-warn{margin:0 0 14px;padding:12px 14px;border-radius:8px;
                border:1px solid rgba(255,180,0,.5);background:rgba(255,180,0,.09);
                color:var(--text-color-high,#f5f5f5);line-height:1.7}
            .ts-wrap{display:flex;flex-wrap:wrap;gap:12px;margin-bottom:12px;align-items:stretch}
            .ts-card{background:var(--background-color-medium,rgba(255,255,255,.04));
                border:1px solid var(--border-color-medium,rgba(255,255,255,.10));
                border-radius:10px;padding:12px;width:180px;text-align:center;
                display:flex;flex-direction:column;justify-content:space-between;
                color:var(--text-color-high,#f5f5f5);box-sizing:border-box}
            .ts-card-wide{width:240px}
            .ts-card-status{min-height:130px}
            .ts-head{font-size:10px;color:var(--text-color-medium,#aaa);
                text-transform:uppercase;margin-bottom:8px;font-weight:600}
            .ts-val{font-size:22px;font-weight:bold;
                color:var(--text-color-high,#f5f5f5);line-height:1.2}
            .ts-unit{font-size:12px;color:var(--text-color-medium,#aaa)}
            .ts-sub{font-size:11px;color:var(--text-color-medium,#aaa);margin-top:4px}
            .ts-pid{font-size:10px;color:var(--text-color-medium,#aaa);
                font-family:monospace;margin-top:2px;display:block;min-height:14px}
            .ts-bar-bg{background:rgba(255,255,255,.08);height:6px;border-radius:3px;
                overflow:hidden;margin:8px 0 4px}
            .ts-bar-fill{background:#2196F3;height:100%;width:0%;
                transition:width .5s ease-in-out}
            .ts-cores-grid{display:flex;gap:6px;height:70px;align-items:flex-end;
                justify-content:center;margin-top:5px}
            .ts-core-col{width:22px;display:flex;flex-direction:column;
                align-items:center;height:100%;justify-content:flex-end}
            .ts-core-track{width:100%;height:55px;background:rgba(255,255,255,.06);
                border-radius:3px;overflow:hidden;border:1px solid rgba(255,255,255,.08);
                display:flex;flex-direction:column-reverse}
            .ts-core-fill{width:100%;background:#4caf50;height:0%;
                transition:height .4s ease-out}
            .ts-core-num{font-size:9px;color:var(--text-color-medium,#aaa);margin-top:3px}
            .ts-ctrl{margin-top:10px;display:flex;gap:6px;
                justify-content:center;flex-wrap:wrap}
            .ts-btn-start  {background:#4caf50!important;color:#fff!important;border:none;
                border-radius:4px;padding:5px 14px;cursor:pointer;font-size:11px;font-weight:bold}
            .ts-btn-stop   {background:#f44336!important;color:#fff!important;border:none;
                border-radius:4px;padding:5px 14px;cursor:pointer;font-size:11px;font-weight:bold}
            .ts-btn-restart{background:#ff9800!important;color:#fff!important;border:none;
                border-radius:4px;padding:5px 14px;cursor:pointer;font-size:11px;font-weight:bold}
            .ts-btn-disabled{background:#555!important;color:#aaa!important;border:none;
                border-radius:4px;padding:5px 14px;cursor:not-allowed;font-size:11px}
            .ts-btn-busy{opacity:.55;filter:grayscale(60%);pointer-events:none}
            .ts-log-bar{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}
            .ts-log{width:100%;box-sizing:border-box;margin-top:6px;
                background:var(--background-color-low,#1a1a1a);
                color:var(--text-color-high,#f8f8f2);border-radius:8px;
                padding:10px;font-family:monospace;font-size:11px;
                height:260px;overflow-y:auto;white-space:pre-wrap;
                border:1px solid var(--border-color-medium,rgba(255,255,255,.12))}
            .ts-hr{margin:16px 0;border:none;border-top:1px solid rgba(255,255,255,.1)}
            .ts-settings{margin-top:4px}
            .ts-section-title{font-size:13px;font-weight:600;
                color:var(--text-color-high,#f5f5f5);margin:14px 0 8px;
                border-bottom:1px solid rgba(255,255,255,.08);padding-bottom:4px}
            .ts-row{display:flex;align-items:center;gap:10px;margin-bottom:7px}
            .ts-label{width:220px;flex-shrink:0;font-size:13px;
                color:var(--text-color-high,#f5f5f5)}
            .ts-field{flex:1}
            .ts-field input[type=text],
            .ts-field input[type=number],
            .ts-field select{width:100%;max-width:320px;box-sizing:border-box}
            .ts-chk{width:16px;height:16px;cursor:pointer}
            .ts-save-row{margin-top:14px;display:flex;gap:8px}
        `]);
    },

    handleSaveApply: null,
    handleSave:      null,
    handleReset:     null
});
