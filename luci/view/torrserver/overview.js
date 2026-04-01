'use strict';
'require view';
'require uci';
'require rpc';
'require fs';
'require ui';
'require poll';
'require request';

/*
 * luci-app-torrserver — overview.js  v7
 *
 * Метрики (RAM, CPU, cores, pid) — с сервера через /api/status (ucode).
 * Сервер читает /proc напрямую в Lua/ucode — никаких ограничений rpcd.
 * Лог — /api/log (popen logread -e torrserver на сервере).
 * Управление — /api/svc/<action> (system() на сервере).
 * JS только рисует полученные данные.
 */

/* базовый URL для API — строится относительно текущего пути LuCI */
const API_BASE = L.url('admin', 'services', 'torrserver', 'api');

function apiGet(endpoint) {
    return request.get(API_BASE + '/' + endpoint).then(function(res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res;
    });
}

function apiJson(endpoint) {
    return apiGet(endpoint).then(function(res) { return res.json(); });
}

function apiText(endpoint) {
    return apiGet(endpoint).then(function(res) { return res.text(); });
}

/* ── View ── */
return view.extend({

    load: function() {
        return Promise.all([
            uci.load('torrserver'),
            uci.load('network')
        ]);
    },

    render: function() {
        const lanIp  = uci.get('network', 'lan', 'ipaddr') || '192.168.1.1';
        const port   = uci.get('torrserver', 'main', 'port') || '8090';
        const webUrl = 'http://' + lanIp + ':' + port;

        const root = E('div', { class: 'ts-root' });
        root.appendChild(this._renderStyles());

        /* placeholder для предупреждения — заполняется первым tick() */
        const warnEl = E('div', { id: 'ts-warn' });
        root.appendChild(warnEl);

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
            apiText('log').then(function(text) {
                logBox.textContent = text || 'Нет событий torrserver в логе.';
                logBox.scrollTop = logBox.scrollHeight;
            }).catch(function(e) {
                logBox.textContent = '[error] ' + e;
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
            click: doRefreshLog
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
        let canCtrl       = false;

        function colorPct(p) { return p > 80 ? '#f44336' : p > 50 ? '#ff9800' : '#4caf50'; }

        function setBarH(id, pct) {
            const e = document.getElementById(id); if (!e) return;
            const h = Math.min(Math.max(Math.round(pct), 0), 100);
            e.style.height = h + '%';
            e.style.backgroundColor = colorPct(h);
        }

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
            if (pendingAction)          return;
            if (lastState === newState) return;
            lastState = newState;
            p.innerHTML = '';

            function mkBtn(label, cls, action) {
                const btn = E('button', {
                    class: 'cbi-button ts-btn-' + cls,
                    click: function() {
                        if (pendingAction) return;
                        pendingAction = action;
                        prevPid = (document.getElementById('ts-pid').textContent.match(/\d+/) || [null])[0];
                        btn.textContent = action === 'start'   ? 'Starting...' :
                                          action === 'stop'    ? 'Stopping...' : 'Restarting...';
                        btn.disabled = true;
                        btn.classList.add('ts-btn-busy');
                        poll.start(1.5);
                        apiJson('svc/' + action).catch(function(e) {
                            console.error('[ts] svc', action, e);
                            pendingAction = null; lastState = null;
                        });
                        setTimeout(function() { if (!pendingAction) poll.start(5); }, 20000);
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

        /* ── главный tick — получает готовый JSON с сервера ── */
        function doTick() {
            return apiJson('status').then(function(d) {
                if (!d) return;

                canCtrl = d.bin_present && d.init_present;

                /* предупреждение */
                const w = document.getElementById('ts-warn');
                if (w) {
                    if (!canCtrl) {
                        w.innerHTML =
                            '<div class="ts-warn">' +
                            '<strong>Нужен daemon TorrServer.</strong><br><br>' +
                            '/usr/bin/torrserver: <b style="color:' + (d.bin_present  ? '#4caf50' : '#f44336') + '">' + (d.bin_present  ? '✓ OK' : '✗ MISSING') + '</b><br>' +
                            '/etc/init.d/torrserver: <b style="color:' + (d.init_present ? '#4caf50' : '#f44336') + '">' + (d.init_present ? '✓ OK' : '✗ MISSING') + '</b>' +
                            '</div>';
                    } else {
                        w.innerHTML = '';
                    }
                }

                /* pendingAction сброс */
                if (pendingAction === 'stop'    && !d.running) { pendingAction = null; lastState = null; prevPid = null; poll.start(5); }
                if (pendingAction === 'start'   &&  d.running) { pendingAction = null; lastState = null; prevPid = null; poll.start(5); }
                if (pendingAction === 'restart' &&  d.running && d.pid && d.pid !== prevPid) {
                    pendingAction = null; lastState = null; prevPid = null; poll.start(5);
                }

                /* статус */
                const st  = document.getElementById('ts-status');
                const pEl = document.getElementById('ts-pid');
                if (!canCtrl) {
                    if (st) st.innerHTML = '<span style="color:#ffb74d">NO DAEMON</span>';
                    renderCtrl(false); return;
                }
                if (d.running) {
                    if (st)  st.innerHTML = '<span style="color:#4caf50">ЗАПУЩЕН</span>';
                    if (pEl) pEl.textContent = d.pid ? 'PID ' + d.pid : '';
                } else {
                    if (pEl) pEl.textContent = '';
                    if (st) {
                        if      (pendingAction === 'stop')    st.innerHTML = '<span style="color:#ff9800">STOPPING...</span>';
                        else if (pendingAction === 'restart') st.innerHTML = '<span style="color:#ff9800">RESTARTING...</span>';
                        else if (pendingAction === 'start')   st.innerHTML = '<span style="color:#ff9800">STARTING...</span>';
                        else                                  st.innerHTML = '<span style="color:#f44336">ОСТАНОВЛЕН</span>';
                    }
                }
                renderCtrl(d.running);

                /* RAM процесса: сервер отдаёт mem_kb (из VmRSS /proc/<pid>/status) */
                const mEl = document.getElementById('ts-mem');
                const bEl = document.getElementById('ts-mem-bar');
                const dEl = document.getElementById('ts-mem-det');
                const cEl = document.getElementById('ts-cpu');

                if (d.running && d.mem_kb) {
                    if (mEl) mEl.textContent = (d.mem_kb / 1024).toFixed(1);
                    if (cEl) cEl.textContent = d.ts_cpu;
                    if (bEl && d.sys_mem && d.sys_mem.total > 0) {
                        const pct = Math.max((d.mem_kb / d.sys_mem.total) * 100, 1);
                        bEl.style.width = pct + '%';
                        bEl.style.backgroundColor = colorPct(pct);
                    }
                } else {
                    if (mEl) mEl.textContent = '0.0';
                    if (cEl) cEl.textContent = '0.0';
                    if (bEl) { bEl.style.width = '0%'; bEl.style.backgroundColor = '#2196F3'; }
                }

                /* системная RAM */
                if (dEl && d.sys_mem && d.sys_mem.total > 0) {
                    const freeMb  = Math.round(d.sys_mem.available / 1024);
                    const totalMb = Math.round(d.sys_mem.total      / 1024);
                    dEl.textContent = 'Free: ' + freeMb + ' MB | Total: ' + totalMb + ' MB';
                }

                /* per-core CPU — сервер отдаёт delta между тиками */
                const ctEl = document.getElementById('ts-cores-txt');
                if (d.cores && d.cores.length) {
                    const labels = d.cores.map(function(v, i) {
                        setBarH('ts-c' + i, v);
                        return Math.round(v) + '%';
                    });
                    if (ctEl) ctEl.textContent = labels.join(' | ');
                }

            }).catch(function(e) {
                console.error('[ts] tick:', e);
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
            return E('input', { class: 'cbi-input-text', type: type || 'text',
                value: v, placeholder: ph || '',
                input: function() { uci.set('torrserver', 'main', opt, this.value); }
            });
        }
        function chk(opt, def) {
            const raw = uci.get('torrserver', 'main', opt);
            const checked = raw != null ? raw === '1' : def === '1';
            const attrs = { type: 'checkbox', class: 'ts-chk',
                change: function() { uci.set('torrserver', 'main', opt, this.checked ? '1' : '0'); }
            };
            if (checked) attrs.checked = 'checked';
            return E('input', attrs);
        }
        function sel(opt, opts, def) {
            const cur = uci.get('torrserver', 'main', opt) || def;
            return E('select', { class: 'cbi-input-select',
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
            advBody.appendChild(row(r[0], r[3] === 'chk' ? chk(r[1],r[2]) : inp(r[1],r[2])));
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
            E('button', { class: 'cbi-button cbi-button-apply',
                click: function() {
                    uci.save().then(function() { return uci.apply(); })
                    .then(function() {
                        ui.addNotification(null, E('p', {}, 'Настройки применены.'), 'info');
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + e), 'danger');
                    });
                }
            }, 'Применить'),
            E('button', { class: 'cbi-button cbi-button-save',
                click: function() {
                    uci.save().then(function() {
                        ui.addNotification(null, E('p', {}, 'Сохранено без применения.'), 'info');
                    });
                }
            }, 'Сохранить'),
            E('button', { class: 'cbi-button cbi-button-reset',
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
