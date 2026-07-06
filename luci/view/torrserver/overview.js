'use strict';
'require view';
'require uci';
'require ui';
'require rpc';

const callStatus = rpc.declare({
    object: 'torrserver',
    method: 'status',
    expect: { '': {
        running: false, pid: null,
        bin_present: false, init_present: false, config_present: false,
        mem_kb: 0, ts_cpu: '0.0',
        sys_mem: { total: 0, free: 0, available: 0 },
        cores: []
    }}
});

const callLog = rpc.declare({
    object: 'torrserver',
    method: 'log',
    expect: { '': { log: '' } }
});

const callStart   = rpc.declare({ object: 'torrserver', method: 'start',   expect: { '': { ok: false } } });
const callStop    = rpc.declare({ object: 'torrserver', method: 'stop',    expect: { '': { ok: false } } });
const callRestart = rpc.declare({ object: 'torrserver', method: 'restart', expect: { '': { ok: false } } });
const callEnable  = rpc.declare({ object: 'torrserver', method: 'enable',  expect: { '': { ok: false } } });
const callDisable = rpc.declare({ object: 'torrserver', method: 'disable', expect: { '': { ok: false } } });

const callNetworkStatus = rpc.declare({
    object: 'network.interface.lan',
    method: 'status',
    expect: { '': {} }
});

function fmtMb(kb, digits) {
    return ((+kb || 0) / 1024).toFixed(digits == null ? 1 : digits);
}

function getLanIp() {
    return callNetworkStatus().then(function(res) {
        /* Берём первый IPv4 адрес из runtime статуса интерфейса */
        const addrs = res && res['ipv4-address'];
        if (addrs && addrs.length > 0 && addrs[0].address)
            return addrs[0].address;
        /* Fallback на UCI */
        return uci.get('network', 'lan', 'ipaddr') || '192.168.1.1';
    }).catch(function() {
        return uci.get('network', 'lan', 'ipaddr') || '192.168.1.1';
    });
}

return view.extend({
    _pollTimer: null,

    load: function() {
        return Promise.all([
            uci.load('torrserver').catch(function() { return null; }),
            getLanIp(),
            callStatus().catch(function() { return {
                running: false, pid: null,
                bin_present: null, init_present: null, config_present: null,
                mem_kb: 0, ts_cpu: '0.0',
                sys_mem: { total: 0, free: 0, available: 0 },
                cores: [],
                status_error: true
            }; })
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
        const lanIp  = data[1] || '192.168.1.1';
        const initial = data[2] || {};
        const port   = uci.get('torrserver', 'main', 'port') || '8090';
        const webUrl = 'http://' + lanIp + ':' + port;

        const root     = E('div', { class: 'ts-root' });
        const banner   = E('div', { id: 'ts-banner' });
        const errorBox = E('div', { class: 'ts-error', style: 'display:none' });
        const wrap     = E('div', { class: 'ts-wrap' });

        const statusVal = E('div', { class: 'ts-val' }, '...');
        const pidVal    = E('small', { class: 'ts-pid' }, '');
        const ctrlPanel = E('div', { class: 'ts-ctrl' });
        const openBtn   = E('button', {
            class: 'cbi-button cbi-button-neutral ts-webui-btn',
            click: function() { window.open(webUrl, '_blank', 'noopener'); }
        }, '↗ Web UI');

        wrap.appendChild(E('div', { class: 'ts-card ts-card-status' }, [
            E('div', { class: 'ts-head' }, 'Сервис'),
            statusVal, pidVal, ctrlPanel, openBtn
        ]));

        const memVal     = E('span', {}, '0');
        const memBar     = E('div', { class: 'ts-bar-fill' });
        const memDetails = E('div', { class: 'ts-sub' }, 'Free: — | Total: —');
        wrap.appendChild(E('div', { class: 'ts-card ts-card-wide' }, [
            E('div', { class: 'ts-head' }, 'RAM'),
            E('div', {}, [ memVal, E('span', { class: 'ts-unit' }, ' MB (RSS)') ]),
            E('div', { class: 'ts-bar-bg' }, [ memBar ]),
            memDetails
        ]));

        const cpuVal = E('span', {}, '0.0');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'CPU (TS)'),
            E('div', { class: 'ts-val' }, [ cpuVal, E('span', { class: 'ts-unit' }, '%') ]),
            E('div', { class: 'ts-sub' }, 'нагрузка процесса')
        ]));

        const coresWrap = E('div', { class: 'ts-cores-grid' });
        const coresTxt  = E('div', { class: 'ts-sub' }, '...');
        wrap.appendChild(E('div', { class: 'ts-card' }, [
            E('div', { class: 'ts-head' }, 'Cores'),
            coresWrap, coresTxt
        ]));

        root.appendChild(self._renderStyles());
        root.appendChild(banner);
        root.appendChild(errorBox);
        root.appendChild(wrap);

        let logVisible = false;
        const logBox = E('div', { class: 'ts-log' }, 'Загрузка...');
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
        root.appendChild(E('hr', { class: 'ts-sep' }));
        root.appendChild(self._renderSettings());

        let pendingAction     = null;
        let fastUntil         = 0;
        let renderedCoreCount = 0;
        let lastStatus        = null;
        let pidBeforeAction   = null;
        let pendingTimeout    = null;

        function pollDelay() { return Date.now() < fastUntil ? 1200 : 4000; }

        function showError(msg) {
            errorBox.style.display = msg ? 'block' : 'none';
            errorBox.textContent = msg || '';
        }

        function colorPct(p) {
            return p > 80 ? '#f44336' : p > 50 ? '#ff9800' : '#4caf50';
        }

        function ensureCoreColumns(count) {
            if (count === renderedCoreCount) return;
            renderedCoreCount = count;
            while (coresWrap.firstChild) coresWrap.removeChild(coresWrap.firstChild);
            for (let i = 0; i < count; i++) {
                coresWrap.appendChild(E('div', { class: 'ts-core-col' }, [
                    E('div', { class: 'ts-core-track' }, [
                        E('div', { 'data-core': String(i), class: 'ts-core-fill' })
                    ]),
                    E('div', { class: 'ts-core-num' }, String(i))
                ]));
            }
        }

        function setBar(idx, pct) {
            const e = coresWrap.querySelector('[data-core="' + idx + '"]');
            if (!e) return;
            const h = Math.min(Math.max(Math.round(+pct || 0), 0), 100);
            e.style.height = h + '%';
            e.style.backgroundColor = colorPct(h);
        }

        function clearPendingTimeout() {
            if (pendingTimeout) { clearTimeout(pendingTimeout); pendingTimeout = null; }
        }

        function setPendingTimeout() {
            clearPendingTimeout();
            /* Сбрасываем pending через 15 сек в любом случае */
            pendingTimeout = setTimeout(function() {
                pendingAction = null;
                if (lastStatus) {
                    renderStatus(lastStatus);
                    renderCtrl(lastStatus);
                }
            }, 15000);
        }

        function renderBanner(st) {
            while (banner.firstChild) banner.removeChild(banner.firstChild);

            if (st.bin_present === null || st.init_present === null || st.config_present === null) {
                banner.appendChild(E('div', { class: 'ts-error' }, [
                    E('strong', {}, 'RPC статус недоступен.'),
                    E('br'), E('br'),
                    E('span', {}, 'Нет ответа от ubus object torrserver. Проверьте статус rpcd.')
                ]));
                return;
            }

            if (st.bin_present && st.init_present && st.config_present) return;

            banner.appendChild(E('div', { class: 'ts-warn' }, [
                E('strong', {}, 'Не все компоненты TorrServer установлены.'),
                E('br'), E('br'),
                E('span', {}, '/usr/bin/torrserver: '),
                E('b', {}, st.bin_present  ? '✓ OK' : '✗ MISSING'), E('br'),
                E('span', {}, '/etc/init.d/torrserver: '),
                E('b', {}, st.init_present ? '✓ OK' : '✗ MISSING'), E('br'),
                E('span', {}, '/etc/config/torrserver: '),
                E('b', {}, st.config_present ? '✓ OK' : '✗ MISSING')
            ]));
        }

        function renderCtrl(st) {
            while (ctrlPanel.firstChild) ctrlPanel.removeChild(ctrlPanel.firstChild);

            /* Web UI кнопка — только если сервис запущен */
            openBtn.disabled = !st.running;
            openBtn.style.opacity = st.running ? '1' : '0.4';

            const canCtrl = !!(st.bin_present && st.init_present);
            if (!canCtrl) {
                ctrlPanel.appendChild(E('button', {
                    class: 'cbi-button ts-btn-disabled', disabled: true
                }, 'daemon missing'));
                return;
            }

            function mkBtn(label, cls, fn) {
                return E('button', {
                    class: 'cbi-button ts-btn-' + cls,
                    disabled: !!pendingAction,
                    click: function(ev) {
                        ev.preventDefault();
                        pendingAction = cls;
                        pidBeforeAction = lastStatus ? lastStatus.pid : null;
                        fastUntil = Date.now() + 15000;
                        setPendingTimeout();
                        renderStatus(st);
                        renderCtrl(st);
                        fn().then(function(reply) {
                            clearPendingTimeout();
                            if (!reply || !reply.ok) {
                                pendingAction = null;
                                renderStatus(lastStatus || st);
                                renderCtrl(lastStatus || st);
                                const hint = reply && reply.detail
                                    ? ' (' + reply.detail + ')' : '';
                                showError('Не удалось выполнить ' + cls + hint);
                                return;
                            }
                            /* backend уже верифицировал — сбрасываем pending и обновляем */
                            pendingAction = null;
                            tick();
                        }).catch(function(err) {
                            clearPendingTimeout();
                            pendingAction = null;
                            renderStatus(lastStatus || st);
                            renderCtrl(lastStatus || st);
                            showError('Ошибка: ' + err.message);
                        });
                    }
                }, label);
            }

            if (st.running) {
                ctrlPanel.appendChild(mkBtn('Stop',    'stop',    callStop));
                ctrlPanel.appendChild(mkBtn('Restart', 'restart', callRestart));
            } else {
                ctrlPanel.appendChild(mkBtn('Start', 'start', callStart));
            }
        }

        function renderStatus(st) {
            if (st.bin_present === null || st.init_present === null) {
                statusVal.textContent = 'RPC ERROR';
                statusVal.className = 'ts-val ts-state-warn';
                pidVal.textContent = '';
                return;
            }
            if (!(st.bin_present && st.init_present)) {
                statusVal.textContent = 'NO DAEMON';
                statusVal.className = 'ts-val ts-state-warn';
                pidVal.textContent = '';
                return;
            }
            if (pendingAction === 'start') {
                statusVal.textContent = st.running ? 'ЗАПУЩЕН' : 'STARTING...';
                statusVal.className = 'ts-val ' + (st.running ? 'ts-state-run' : 'ts-state-warn');
            } else if (pendingAction === 'stop') {
                statusVal.textContent = st.running ? 'STOPPING...' : 'ОСТАНОВЛЕН';
                statusVal.className = 'ts-val ' + (st.running ? 'ts-state-warn' : 'ts-state-stop');
            } else if (pendingAction === 'restart') {
                statusVal.textContent = 'RESTARTING...';
                statusVal.className = 'ts-val ts-state-warn';
            } else if (st.running) {
                statusVal.textContent = 'ЗАПУЩЕН';
                statusVal.className = 'ts-val ts-state-run';
            } else {
                statusVal.textContent = 'ОСТАНОВЛЕН';
                statusVal.className = 'ts-val ts-state-stop';
            }
            pidVal.textContent = st.pid ? ('PID ' + st.pid) : '';
        }

        function renderMetrics(st) {
            const running = !!st.running;
            const total   = +(st.sys_mem && st.sys_mem.total     || 0);
            const avail   = +(st.sys_mem && st.sys_mem.available || 0);
            const memKb   = +(st.mem_kb  || 0);
            const cpuPct  = parseFloat(st.ts_cpu || '0') || 0;
            const cores   = Array.isArray(st.cores) ? st.cores : [];

            memVal.textContent = running ? fmtMb(memKb, 1) : '0.0';
            memDetails.textContent = total > 0
                ? ('Free: ' + fmtMb(avail, 0) + ' MB | Total: ' + fmtMb(total, 0) + ' MB')
                : 'Free: — | Total: —';
            memBar.style.width = (running && total > 0)
                ? Math.max((memKb / total) * 100, 1) + '%' : '0%';
            cpuVal.textContent = running ? cpuPct.toFixed(1) : '0.0';

            ensureCoreColumns(cores.length);
            coresTxt.textContent = cores.length ? cores.map(function(v, i) {
                setBar(i, v);
                return 'CPU' + i + ': ' + (+v).toFixed(1) + '%';
            }).join(' | ') : '—';
        }

        function refreshLog() {
            if (!logVisible) return;
            callLog().then(function(res) {
                logBox.textContent = (res && res.log) ? res.log : 'Лог пуст.';
                logBox.scrollTop = logBox.scrollHeight;
            }).catch(function(err) {
                logBox.textContent = 'Ошибка: ' + err.message;
            });
        }

        function tick() {
            callStatus().then(function(st) {
                lastStatus = st;
                showError('');
                renderBanner(st);
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
                class: 'cbi-input-text', type: type || 'text',
                value: val, placeholder: placeholder || '',
                input: function() { uci.set('torrserver', 'main', opt, this.value); }
            };
            if (min !== undefined) attrs.min = String(min);
            if (max !== undefined) attrs.max = String(max);
            return E('input', attrs);
        }

        function chk(opt, def) {
            const val = uci.get('torrserver', 'main', opt);
            const checked = val !== undefined ? val === '1' : def === '1';
            return E('input', {
                type: 'checkbox', checked: checked, class: 'ts-chk',
                change: function() { uci.set('torrserver', 'main', opt, this.checked ? '1' : '0'); }
            });
        }

        /* Чекбокс автозапуска — синхронизирует и UCI и rc.d enable/disable */
        function chkAutostart() {
            const val = uci.get('torrserver', 'main', 'enabled');
            const checked = val !== undefined ? val === '1' : true;
            return E('input', {
                type: 'checkbox', checked: checked, class: 'ts-chk',
                change: function() {
                    const en = this.checked;
                    uci.set('torrserver', 'main', 'enabled', en ? '1' : '0');
                    /* Синхронизируем rc.d */
                    (en ? callEnable() : callDisable()).catch(function() {});
                }
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
        wrap.appendChild(row('Автозапуск',         chkAutostart()));
        wrap.appendChild(row('Порт',               inp('port', '8090', 'number', 1, 65535)));
        wrap.appendChild(row('Рабочая директория', inp('path', '/opt/torrserver')));
        wrap.appendChild(row('Режим прокси',       sel('proxymode', ['tracker','peers','full'], 'tracker')));

        const advBody  = E('div', { style: 'display:none' });
        const advTitle = E('h3', {
            class: 'ts-section-title ts-adv-toggle', style: 'cursor:pointer',
            click: function() {
                advBody.style.display = advBody.style.display === 'none' ? '' : 'none';
                this.textContent = advBody.style.display === 'none'
                    ? '▶ Дополнительные настройки' : '▼ Дополнительные настройки';
            }
        }, '▶ Дополнительные настройки');

        advBody.appendChild(row('IP для bind',         inp('ip', '0.0.0.0')));
        advBody.appendChild(row('--dontkill',          chk('dontkill', '1')));
        advBody.appendChild(row('HTTP auth',           chk('httpauth', '0')));
        advBody.appendChild(row('RDB режим',           chk('rdb', '0')));
        advBody.appendChild(row('Путь к логу',         inp('logpath', '/tmp/torrserver.log')));
        advBody.appendChild(row('Путь к web-логу',     inp('weblogpath', '/tmp/torrserver-web.log')));
        advBody.appendChild(row('Каталог torrents',    inp('torrentsdir', '/opt/torrserver/torrents')));
        advBody.appendChild(row('Torrent listen addr', inp('torrentaddr', 'example.com:6881')));
        advBody.appendChild(row('Публичный IPv4',      inp('pubipv4', '')));
        advBody.appendChild(row('Публичный IPv6',      inp('pubipv6', '')));
        advBody.appendChild(row('Web/API поиск',       chk('searchwa', '0')));
        advBody.appendChild(row('Макс. размер',        inp('maxsize', '64M')));
        advBody.appendChild(row('Telegram',            inp('tg', '')));
        advBody.appendChild(row('FUSE',                inp('fuse', '')));
        advBody.appendChild(row('WebDAV',              chk('webdav', '0')));
        advBody.appendChild(row('Proxy URL',           inp('proxyurl', 'http://127.0.0.1:8080')));
        wrap.appendChild(advTitle);
        wrap.appendChild(advBody);

        wrap.appendChild(E('div', { class: 'ts-save-row' }, [
            E('button', {
                class: 'cbi-button cbi-button-apply',
                click: function() {
                    uci.save().then(function() {
                        return uci.apply(30);
                    }).then(function() {
                        ui.addNotification(null, E('p', {}, 'Настройки применены.'), 'info');
                        /* После apply — обновляем статус чтобы убедиться что сервис поднялся */
                        setTimeout(function() {
                            callStatus().then(function(st) {
                                if (st && !st.running && st.bin_present && st.init_present) {
                                    ui.addNotification(null,
                                        E('p', {}, 'Внимание: сервис не запущен после применения настроек.'),
                                        'warning');
                                }
                            }).catch(function() {});
                        }, 1500);
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
                        if (r) r.replaceWith(self._renderSettings());
                        ui.addNotification(null, E('p', {}, 'Сброшено.'), 'info');
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
            .ts-sep { margin: 20px 0; border: 0; border-top: 1px solid var(--border-color-medium, rgba(127,127,127,.25)); }
            .ts-warn, .ts-error { margin: 0 0 16px; padding: 12px 14px; border-radius: 8px; color: var(--text-color-high, #f5f5f5); }
            .ts-warn  { border: 1px solid rgba(255,180,0,.45); background: rgba(255,180,0,.10); }
            .ts-error { border: 1px solid rgba(244,67,54,.45); background: rgba(244,67,54,.10); }
            .ts-wrap  { display: flex; flex-wrap: wrap; gap: 14px; margin-bottom: 18px; align-items: stretch; }
            .ts-card  { background: var(--background-color-medium, rgba(255,255,255,.04)); border: 1px solid var(--border-color-medium, rgba(255,255,255,.10)); border-radius: 10px; padding: 12px; width: 180px; text-align: center; display: flex; flex-direction: column; justify-content: space-between; color: var(--text-color-high, #f5f5f5); box-sizing: border-box; }
            .ts-card-wide { width: 240px; }
            .ts-card-status { min-height: 160px; }
            .ts-head  { font-size: 10px; color: var(--text-color-medium, #aaa); text-transform: uppercase; margin-bottom: 8px; font-weight: 600; letter-spacing: .04em; }
            .ts-val   { font-size: 22px; font-weight: 700; color: var(--text-color-high, #f5f5f5); line-height: 1.2; }
            .ts-state-run  { color: #4caf50; }
            .ts-state-stop { color: #f44336; }
            .ts-state-warn { color: #ff9800; }
            .ts-unit { font-size: 12px; color: var(--text-color-medium, #aaa); }
            .ts-sub  { font-size: 11px; color: var(--text-color-medium, #aaa); margin-top: 4px; }
            .ts-pid  { font-size: 10px; color: var(--text-color-medium, #aaa); font-family: monospace; margin-top: 2px; min-height: 14px; }
            .ts-bar-bg   { background: var(--background-color-low, rgba(255,255,255,.08)); height: 6px; border-radius: 3px; overflow: hidden; margin: 8px 0 4px; }
            .ts-bar-fill { background: #2196f3; height: 100%; width: 0%; transition: width .35s ease-in-out; }
            .ts-cores-grid { display: flex; gap: 6px; height: 70px; align-items: flex-end; justify-content: center; margin-top: 5px; }
            .ts-core-col   { width: 22px; display: flex; flex-direction: column; align-items: center; height: 100%; justify-content: flex-end; }
            .ts-core-track { width: 100%; height: 55px; background: var(--background-color-low, rgba(255,255,255,.06)); border-radius: 3px; overflow: hidden; border: 1px solid var(--border-color-medium, rgba(255,255,255,.08)); display: flex; flex-direction: column-reverse; }
            .ts-core-fill  { width: 100%; background: #4caf50; height: 0%; transition: height .35s ease-out; }
            .ts-core-num   { font-size: 9px; color: var(--text-color-medium, #aaa); margin-top: 3px; }
            .ts-ctrl { margin-top: 10px; display: flex; gap: 6px; justify-content: center; flex-wrap: wrap; }
            .ts-btn-start, .ts-btn-stop, .ts-btn-restart, .ts-btn-disabled { color: #fff !important; border: none; border-radius: 4px; padding: 5px 10px; font-size: 11px; min-width: 68px; }
            .ts-btn-start    { background: #4caf50 !important; }
            .ts-btn-stop     { background: #f44336 !important; }
            .ts-btn-restart  { background: #ff9800 !important; }
            .ts-btn-disabled { background: #666 !important; color: #ddd !important; cursor: not-allowed; }
            .ts-webui-btn { margin-top: 8px; width: 100%; font-size: 11px; transition: opacity .2s; }
            .ts-log { width: 100%; box-sizing: border-box; background: var(--background-color-low, rgba(0,0,0,.4)); color: var(--text-color-high, #f8f8f2); border-radius: 8px; padding: 10px; font-family: monospace; font-size: 11px; height: 260px; overflow-y: auto; white-space: pre-wrap; border: 1px solid var(--border-color-medium, rgba(255,255,255,.08)); margin-top: 8px; }
            .ts-settings { margin-top: 4px; }
            .ts-section-title { font-size: 13px; font-weight: 600; color: var(--text-color-high, #f5f5f5); margin: 16px 0 8px; border-bottom: 1px solid var(--border-color-medium, rgba(255,255,255,.08)); padding-bottom: 4px; }
            .ts-row   { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
            .ts-label { width: 220px; flex-shrink: 0; font-size: 13px; color: var(--text-color-high, #f5f5f5); }
            .ts-field { flex: 1; min-width: 260px; }
            .ts-field input[type=text], .ts-field input[type=number], .ts-field select { width: 100%; max-width: 420px; box-sizing: border-box; }
            .ts-chk { width: 16px; height: 16px; cursor: pointer; }
            .ts-save-row { margin-top: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
        `]);
    },

    handleSaveApply: null,
    handleSave: null,
    handleReset: null
});
