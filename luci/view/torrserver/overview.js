'use strict';
'require view';
'require uci';
'require ui';

function apiUrl(path) {
    return L.url('admin/services/torrserver/api/' + path);
}

function fetchText(path) {
    return window.fetch(apiUrl(path), {
        method: 'GET',
        headers: { 'Accept': 'text/plain, application/json' },
        cache: 'no-store',
        credentials: 'same-origin'
    }).then(function(res) {
        if (!res.ok)
            throw new Error('HTTP ' + res.status);
        return res.text();
    });
}

function fetchJson(path) {
    return fetchText(path).then(function(text) {
        try {
            return JSON.parse(text);
        }
        catch (e) {
            throw new Error('Invalid JSON from ' + path + ': ' + e.message);
        }
    });
}

function svcAction(action) {
    return fetchJson('svc/' + encodeURIComponent(action));
}

function getStatus() {
    return fetchJson('status');
}

function getLog() {
    return fetchText('log');
}

function getLanIp() {
    return uci.load('network').then(function() {
        return uci.get('network', 'lan', 'ipaddr') || '192.168.1.1';
    }).catch(function() {
        return '192.168.1.1';
    });
}

function fmtMb(kb, digits) {
    return ((+kb || 0) / 1024).toFixed(digits == null ? 1 : digits);
}

return view.extend({
    _pollTimer: null,

    load: function() {
        return Promise.all([
            uci.load('torrserver').catch(function() { return null; }),
            getLanIp(),
            getStatus().catch(function() {
                return {
                    running: false,
                    pid: null,
                    bin_present: false,
                    init_present: false,
                    config_present: false,
                    mem_kb: 0,
                    ts_cpu: '0.0',
                    sys_mem: { total: 0, free: 0, available: 0 },
                    cores: []
                };
            })
        ]);
    },

    remove: function() {
        if (this._pollTimer) {
            clearTimeout(this._pollTimer);
            this._pollTimer = null;
        }
    },

    render: function(data) {
        const self = this;
        const lanIp = data[1] || '192.168.1.1';
        const initial = data[2] || {};
        const port = uci.get('torrserver', 'main', 'port') || '8090';
        const webUrl = 'http://' + lanIp + ':' + port;

        const root = E('div', { class: 'ts-root' });
        const banner = E('div', { id: 'ts-banner' });
        const errorBox = E('div', { id: 'ts-error', class: 'ts-error', style: 'display:none' });
        const wrap = E('div', { class: 'ts-wrap' });

        const statusVal = E('div', { id: 'ts-status', class: 'ts-val' }, '...');
        const pidVal = E('small', { id: 'ts-pid', class: 'ts-pid' }, '');
        const ctrlPanel = E('div', { id: 'ts-ctrl', class: 'ts-ctrl' });
        const openBtn = E('button', {
            class: 'cbi-button cbi-button-neutral ts-webui-btn',
            click: function() { window.open(webUrl, '_blank', 'noopener'); }
        }, '↗ Web UI');

        wrap.appendChild(E('div', { class: 'ts-card ts-card-status' }, [
            E('div', { class: 'ts-head' }, 'Сервис'),
            statusVal, pidVal, ctrlPanel, openBtn
        ]));

        const memVal = E('span', { id: 'ts-mem' }, '0');
        const memBar = E('div', { id: 'ts-mem-bar', class: 'ts-bar-fill' });
        const memDetails = E('div', { id: 'ts-mem-det', class: 'ts-sub' }, 'Free: — | Total: —');
        wrap.appendChild(E('div', { class: 'ts-card ts-card-wide' }, [
            E('div', { class: 'ts-head' }, 'RAM'),
            E('div', {}, [ memVal, E('span', { class: 'ts-unit' }, ' MB (RSS)') ]),
            E('div', { class: 'ts-bar-bg' }, [ memBar ]),
            memDetails
        ]));

        const cpuVal = E('span', { id: 'ts-cpu' }, '0.0');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'CPU (TS)'),
            E('div', { class: 'ts-val' }, [ cpuVal, E('span', { class: 'ts-unit' }, '%') ]),
            E('div', { class: 'ts-sub' }, 'нагрузка процесса')
        ]));

        const coresWrap = E('div', { id: 'ts-cores-grid', class: 'ts-cores-grid' });
        const coresTxt = E('div', { id: 'ts-cores-txt', class: 'ts-sub' }, '...');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'Cores'),
            coresWrap,
            coresTxt
        ]));

        root.appendChild(self._renderStyles());
        root.appendChild(banner);
        root.appendChild(errorBox);
        root.appendChild(wrap);

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
                if (logVisible)
                    refreshLog();
            }
        }, '▼ Показать лог');
        root.appendChild(logBtn);
        root.appendChild(logBox);

        root.appendChild(E('hr', { class: 'ts-sep' }));
        root.appendChild(self._renderSettings());

        let pendingAction = null;
        let fastUntil = 0;
        let renderedCoreCount = 0;
        let lastStatus = null;
        let pidBeforeAction = null;

        function pollDelay() {
            return (Date.now() < fastUntil) ? 1200 : 4000;
        }

        function showError(msg) {
            errorBox.style.display = msg ? 'block' : 'none';
            errorBox.textContent = msg || '';
        }

        function colorPct(p) {
            return p > 80 ? '#f44336' : p > 50 ? '#ff9800' : '#4caf50';
        }

        function ensureCoreColumns(count) {
            if (count === renderedCoreCount)
                return;
            renderedCoreCount = count;
            while (coresWrap.firstChild)
                coresWrap.removeChild(coresWrap.firstChild);
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
            const e = coresWrap.querySelector('#' + id);
            if (!e)
                return;
            const h = Math.min(Math.max(Math.round(+pct || 0), 0), 100);
            e.style.height = h + '%';
            e.style.backgroundColor = colorPct(h);
        }

        function renderBanner(st) {
            while (banner.firstChild)
                banner.removeChild(banner.firstChild);

            const binOk = !!st.bin_present;
            const initOk = !!st.init_present;
            const cfgOk = !!st.config_present;

            if (binOk && initOk && cfgOk)
                return;

            banner.appendChild(E('div', { class: 'ts-warn' }, [
                E('strong', {}, 'Не все компоненты TorrServer установлены.'),
                E('br'), E('br'),
                E('span', {}, '/usr/bin/torrserver: '),
                E('b', {}, binOk ? '✓ OK' : '✗ MISSING'), E('br'),
                E('span', {}, '/etc/init.d/torrserver: '),
                E('b', {}, initOk ? '✓ OK' : '✗ MISSING'), E('br'),
                E('span', {}, '/etc/config/torrserver: '),
                E('b', {}, cfgOk ? '✓ OK' : '✗ MISSING')
            ]));
        }

        function renderCtrl(st) {
            const p = ctrlPanel;
            const canCtrl = !!(st.bin_present && st.init_present);

            while (p.firstChild)
                p.removeChild(p.firstChild);

            if (!canCtrl) {
                p.appendChild(E('button', {
                    class: 'cbi-button ts-btn-disabled',
                    disabled: true
                }, 'daemon missing'));
                return;
            }

            function mkBtn(label, cls, action) {
                return E('button', {
                    class: 'cbi-button ts-btn-' + cls,
                    disabled: !!pendingAction,
                    click: function(ev) {
                        ev.preventDefault();
                        pendingAction = action;
                        pidBeforeAction = lastStatus ? lastStatus.pid : null;
                        fastUntil = Date.now() + 15000;
                        renderStatus(st);
                        renderCtrl(st);
                        svcAction(action).then(function(reply) {
                            if (!reply || !reply.ok) {
                                const hint = reply && reply.detail === 'lingering_processes'
                                    ? ' (процесс не завершился — проверьте вручную)'
                                    : reply && reply.detail === 'start_failed'
                                        ? ' (не удалось запустить после остановки)'
                                        : '';
                                throw new Error('service action failed' + hint);
                            }
                            setTimeout(tick, 700);
                            setTimeout(tick, 1700);
                            setTimeout(tick, 3000);
                        }).catch(function(err) {
                            pendingAction = null;
                            renderStatus(lastStatus || st);
                            renderCtrl(lastStatus || st);
                            showError('Не удалось выполнить ' + action + ': ' + err.message);
                        });
                    }
                }, label);
            }

            if (st.running) {
                p.appendChild(mkBtn('Stop', 'stop', 'stop'));
                p.appendChild(mkBtn('Restart', 'restart', 'restart'));
            }
            else {
                p.appendChild(mkBtn('Start', 'start', 'start'));
            }
        }

        function renderStatus(st) {
            if (!(st.bin_present && st.init_present)) {
                statusVal.textContent = 'NO DAEMON';
                statusVal.className = 'ts-val ts-state-warn';
                pidVal.textContent = '';
                return;
            }

            if (pendingAction === 'start') {
                statusVal.textContent = st.running ? 'ЗАПУЩЕН' : 'STARTING...';
                statusVal.className = 'ts-val ' + (st.running ? 'ts-state-run' : 'ts-state-warn');
            }
            else if (pendingAction === 'stop') {
                statusVal.textContent = st.running ? 'STOPPING...' : 'ОСТАНОВЛЕН';
                statusVal.className = 'ts-val ' + (st.running ? 'ts-state-warn' : 'ts-state-stop');
            }
            else if (pendingAction === 'restart') {
                statusVal.textContent = 'RESTARTING...';
                statusVal.className = 'ts-val ts-state-warn';
            }
            else if (st.running) {
                statusVal.textContent = 'ЗАПУЩЕН';
                statusVal.className = 'ts-val ts-state-run';
            }
            else {
                statusVal.textContent = 'ОСТАНОВЛЕН';
                statusVal.className = 'ts-val ts-state-stop';
            }

            pidVal.textContent = st.pid ? ('PID ' + st.pid) : '';
        }

        function renderMetrics(st) {
            const running = !!st.running;
            const total = +(st.sys_mem && st.sys_mem.total || 0);
            const avail = +(st.sys_mem && st.sys_mem.available || 0);
            const memKb = +(st.mem_kb || 0);
            const cpuPct = parseFloat(st.ts_cpu || '0') || 0;
            const cores = Array.isArray(st.cores) ? st.cores : [];

            memVal.textContent = running ? fmtMb(memKb, 1) : '0.0';
            memDetails.textContent = total > 0
                ? ('Free: ' + fmtMb(avail, 0) + ' MB | Total: ' + fmtMb(total, 0) + ' MB')
                : 'Free: — | Total: —';
            memBar.style.width = (running && total > 0)
                ? Math.max((memKb / total) * 100, 1) + '%'
                : '0%';
            cpuVal.textContent = running ? cpuPct.toFixed(1) : '0.0';

            ensureCoreColumns(cores.length);
            coresTxt.textContent = cores.length ? cores.map(function(v, i) {
                setBar('ts-c' + i, v);
                return 'CPU' + i + ': ' + (+v).toFixed(1) + '%';
            }).join(' | ') : '—';
        }

        function refreshLog() {
            if (!logVisible)
                return Promise.resolve();
            return getLog().then(function(text) {
                logBox.textContent = text || 'Лог пуст.';
                logBox.scrollTop = logBox.scrollHeight;
            }).catch(function(err) {
                logBox.textContent = 'Ошибка чтения лога: ' + err.message;
            });
        }

        function tick() {
            getStatus().then(function(st) {
                lastStatus = st;
                showError('');
                renderBanner(st);

                if (pendingAction === 'start' && st.running)
                    pendingAction = null;
                else if (pendingAction === 'stop' && !st.running)
                    pendingAction = null;
                else if (pendingAction === 'restart' && st.running && st.pid &&
                         pidBeforeAction && st.pid !== pidBeforeAction)
                    pendingAction = null;

                renderStatus(st);
                renderCtrl(st);
                renderMetrics(st);
                refreshLog();
            }).catch(function(err) {
                showError('Ошибка обновления статуса: ' + err.message);
            });
        }

        function schedulePoll() {
            self._pollTimer = setTimeout(function() {
                tick();
                schedulePoll();
            }, pollDelay());
        }

        renderBanner(initial);
        renderStatus(initial);
        renderCtrl(initial);
        renderMetrics(initial);
        tick();
        schedulePoll();

        return root;
    },

    _renderSettings: function() {
        const self = this;
        const wrap = E('div', { class: 'ts-settings' });

        function row(label, el) {
            return E('div', { class: 'ts-row' }, [
                E('label', { class: 'ts-label' }, label),
                E('div', { class: 'ts-field' }, [ el ])
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
            if (min !== undefined)
                attrs.min = String(min);
            if (max !== undefined)
                attrs.max = String(max);
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

        wrap.appendChild(E('h3', { class: 'ts-section-title' }, 'Основные настройки'));
        wrap.appendChild(row('Автозапуск', chk('enabled', '1')));
        wrap.appendChild(row('Порт', inp('port', '8090', 'number', 1, 65535)));
        wrap.appendChild(row('Рабочая директория', inp('path', '/opt/torrserver')));
        wrap.appendChild(row('Режим прокси', sel('proxymode', ['tracker', 'all', 'off'], 'tracker')));

        const advBody = E('div', { style: 'display:none' });
        const advTitle = E('h3', {
            class: 'ts-section-title ts-adv-toggle',
            style: 'cursor:pointer',
            click: function() {
                advBody.style.display = advBody.style.display === 'none' ? '' : 'none';
                this.textContent = advBody.style.display === 'none' ? '▶ Дополнительные настройки' : '▼ Дополнительные настройки';
            }
        }, '▶ Дополнительные настройки');

        advBody.appendChild(row('IP для bind', inp('ip', '0.0.0.0')));
        advBody.appendChild(row('--dontkill', chk('dontkill', '1')));
        advBody.appendChild(row('HTTP auth', chk('httpauth', '0')));
        advBody.appendChild(row('RDB режим', chk('rdb', '0')));
        advBody.appendChild(row('Путь к логу', inp('logpath', '/tmp/torrserver.log')));
        advBody.appendChild(row('Путь к web-логу', inp('weblogpath', '/tmp/torrserver-web.log')));
        advBody.appendChild(row('Каталог torrents', inp('torrentsdir', '/opt/torrserver/torrents')));
        advBody.appendChild(row('Torrent listen addr', inp('torrentaddr', 'example.com:6881')));
        advBody.appendChild(row('Публичный IPv4', inp('pubipv4', '')));
        advBody.appendChild(row('Публичный IPv6', inp('pubipv6', '')));
        advBody.appendChild(row('Web/API поиск', chk('searchwa', '0')));
        advBody.appendChild(row('Макс. размер', inp('maxsize', '64M')));
        advBody.appendChild(row('Telegram', inp('tg', '')));
        advBody.appendChild(row('FUSE', inp('fuse', '')));
        advBody.appendChild(row('WebDAV', chk('webdav', '0')));
        advBody.appendChild(row('Proxy URL', inp('proxyurl', 'http://127.0.0.1:8080')));

        wrap.appendChild(advTitle);
        wrap.appendChild(advBody);

        wrap.appendChild(E('div', { class: 'ts-save-row' }, [
            E('button', {
                class: 'cbi-button cbi-button-apply',
                click: function() {
                    uci.save().then(function() {
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
                        ui.addNotification(null, E('p', {}, 'Настройки сохранены.'), 'info');
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + e.message), 'danger');
                    });
                }
            }, 'Сохранить'),
            E('button', {
                class: 'cbi-button cbi-button-reset',
                click: function() {
                    uci.unload('torrserver');
                    uci.load('torrserver').then(function() {
                        const r = document.querySelector('.ts-settings');
                        if (r)
                            r.replaceWith(self._renderSettings());
                        ui.addNotification(null, E('p', {}, 'Сброшено до сохранённых значений.'), 'info');
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + e.message), 'danger');
                    });
                }
            }, 'Сбросить')
        ]));

        return wrap;
    },

    _renderStyles: function() {
        return E('style', {}, [`
            .ts-root { font-size: 14px; }
            .ts-sep {
                margin: 20px 0;
                border: 0;
                border-top: 1px solid var(--border-color-medium, rgba(127,127,127,.25));
            }
            .ts-warn, .ts-error {
                margin: 0 0 16px;
                padding: 12px 14px;
                border-radius: 8px;
                color: var(--text-color-high, #f5f5f5);
            }
            .ts-warn {
                border: 1px solid rgba(255,180,0,.45);
                background: rgba(255,180,0,.10);
            }
            .ts-error {
                border: 1px solid rgba(244,67,54,.45);
                background: rgba(244,67,54,.10);
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
                box-shadow: var(--widget-box-shadow, none);
            }
            .ts-card-wide { width: 240px; }
            .ts-card-status { min-height: 160px; }
            .ts-head {
                font-size: 10px;
                color: var(--text-color-medium, #aaa);
                text-transform: uppercase;
                margin-bottom: 8px;
                font-weight: 600;
                letter-spacing: .04em;
            }
            .ts-val {
                font-size: 22px;
                font-weight: 700;
                color: var(--text-color-high, #f5f5f5);
                line-height: 1.2;
            }
            .ts-state-run { color: #4caf50; }
            .ts-state-stop { color: #f44336; }
            .ts-state-warn { color: #ff9800; }
            .ts-unit { font-size: 12px; color: var(--text-color-medium, #aaa); }
            .ts-sub { font-size: 11px; color: var(--text-color-medium, #aaa); margin-top: 4px; }
            .ts-pid { font-size: 10px; color: var(--text-color-medium, #aaa); font-family: monospace; margin-top: 2px; min-height: 14px; }
            .ts-bar-bg {
                background: var(--background-color-low, rgba(255,255,255,.08));
                height: 6px;
                border-radius: 3px;
                overflow: hidden;
                margin: 8px 0 4px;
            }
            .ts-bar-fill {
                background: #2196f3;
                height: 100%;
                width: 0%;
                transition: width .35s ease-in-out;
            }
            .ts-cores-grid {
                display: flex;
                gap: 6px;
                height: 70px;
                align-items: flex-end;
                justify-content: center;
                margin-top: 5px;
            }
            .ts-core-col { width: 22px; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
            .ts-core-track {
                width: 100%;
                height: 55px;
                background: var(--background-color-low, rgba(255,255,255,.06));
                border-radius: 3px;
                overflow: hidden;
                border: 1px solid var(--border-color-medium, rgba(255,255,255,.08));
                display: flex;
                flex-direction: column-reverse;
            }
            .ts-core-fill { width: 100%; background: #4caf50; height: 0%; transition: height .35s ease-out; }
            .ts-core-num { font-size: 9px; color: var(--text-color-medium, #aaa); margin-top: 3px; }
            .ts-ctrl { margin-top: 10px; display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
            .ts-btn-start, .ts-btn-stop, .ts-btn-restart, .ts-btn-disabled {
                color: #fff !important;
                border: none;
                border-radius: 4px;
                padding: 5px 10px;
                font-size: 11px;
                min-width: 68px;
            }
            .ts-btn-start { background: #4caf50 !important; }
            .ts-btn-stop { background: #f44336 !important; }
            .ts-btn-restart { background: #ff9800 !important; }
            .ts-btn-disabled { background: #666 !important; color: #ddd !important; cursor: not-allowed; }
            .ts-webui-btn { margin-top: 8px; width: 100%; font-size: 11px; }
            .ts-log {
                width: 100%;
                box-sizing: border-box;
                background: var(--background-color-low, rgba(0,0,0,.4));
                color: var(--text-color-high, #f8f8f2);
                border-radius: 8px;
                padding: 10px;
                font-family: monospace;
                font-size: 11px;
                height: 260px;
                overflow-y: auto;
                white-space: pre-wrap;
                border: 1px solid var(--border-color-medium, rgba(255,255,255,.08));
                margin-top: 8px;
            }
            .ts-settings { margin-top: 4px; }
            .ts-section-title {
                font-size: 13px;
                font-weight: 600;
                color: var(--text-color-high, #f5f5f5);
                margin: 16px 0 8px;
                border-bottom: 1px solid var(--border-color-medium, rgba(255,255,255,.08));
                padding-bottom: 4px;
            }
            .ts-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
            .ts-label {
                width: 220px;
                flex-shrink: 0;
                font-size: 13px;
                color: var(--text-color-high, #f5f5f5);
            }
            .ts-field { flex: 1; min-width: 260px; }
            .ts-field input[type=text],
            .ts-field input[type=number],
            .ts-field select {
                width: 100%;
                max-width: 420px;
                box-sizing: border-box;
            }
            .ts-chk { width: 16px; height: 16px; cursor: pointer; }
            .ts-save-row { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
        `]);
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
