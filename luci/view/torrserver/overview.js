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

const callStartCustom   = rpc.declare({ object: 'torrserver', method: 'start',   expect: { '': { ok: false } } });
const callStopCustom    = rpc.declare({ object: 'torrserver', method: 'stop',    expect: { '': { ok: false } } });
const callRestartCustom = rpc.declare({ object: 'torrserver', method: 'restart', expect: { '': { ok: false } } });
const callEnableCustom  = rpc.declare({ object: 'torrserver', method: 'enable',  expect: { '': { ok: false } } });
const callDisableCustom = rpc.declare({ object: 'torrserver', method: 'disable', expect: { '': { ok: false } } });


const callInitList = rpc.declare({
    object: 'luci',
    method: 'getInitList',
    params: [ 'name' ],
    expect: { '': {} }
});

const callInitActionRaw = rpc.declare({
    object: 'luci',
    method: 'setInitAction',
    params: [ 'name', 'action' ],
    expect: { result: false }
});

const callProcessList = rpc.declare({
    object: 'luci',
    method: 'getProcessList',
    expect: { result: [] }
});

function callInitAction(action) {
    return callInitActionRaw('torrserver', action).then(function(res) {
        const ok = (res === true);
        return { ok: ok, detail: ok ? action : 'init_action_failed' };
    });
}

const callStart   = function() { return callInitAction('start'); };
const callStop    = function() { return callInitAction('stop'); };
const callRestart = function() { return callInitAction('restart'); };
const callEnable  = function() { return callInitAction('enable'); };
const callDisable = function() { return callInitAction('disable'); };

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

function hostForUrl(host) {
    host = host || '';
    if (host.indexOf(':') >= 0 && host.charAt(0) !== '[')
        return '[' + host + ']';
    return host;
}

function buildWebUrl(port, lanIp) {
    /*
     * Предпочитаем hostname текущей LuCI-сессии. Если LuCI открыт через
     * Tailscale/VPN/проброс, LAN IP роутера из network.lan часто недоступен
     * браузеру пользователя.
     */
    const host = (window.location && window.location.hostname) || lanIp || '192.168.1.1';
    return 'http://' + hostForUrl(host) + ':' + (port || '8090') + '/';
}

function rpcErrorHint(err) {
    const msg = err && err.message ? err.message : String(err || 'unknown error');
    if (/access denied|permission denied|403/i.test(msg))
        return msg + ' — проверьте ACL luci-app-torrserver и перезапустите rpcd.';
    if (/object not found|not found/i.test(msg))
        return msg + ' — custom backend не зарегистрирован; service actions выполняются через штатный объект luci.';
    return msg;
}


function firstValue(obj, keys) {
    for (let i = 0; i < keys.length; i++) {
        if (obj && obj[keys[i]] != null)
            return obj[keys[i]];
    }
    return null;
}

function processCommand(p) {
    const cmd = firstValue(p, [ 'command', 'COMMAND', 'cmd', 'cmdline', 'args', 'name' ]);
    if (Array.isArray(cmd))
        return cmd.join(' ');
    return String(cmd || '');
}

function findTorrServerProcess(list) {
    if (!Array.isArray(list))
        list = list && typeof(list) === 'object' ? Object.keys(list).map(function(k) { return list[k]; }) : [];

    for (let i = 0; i < list.length; i++) {
        const p = list[i] || {};
        const cmd = processCommand(p);
        if (cmd.indexOf('/usr/bin/torrserver') >= 0 || /(^|\s)torrserver(\s|$)/.test(cmd))
            return p;
    }
    return null;
}

function fallbackStatus() {
    return Promise.all([
        callInitList('torrserver').catch(function() { return {}; }),
        callProcessList().catch(function() { return []; })
    ]).then(function(data) {
        const init = data[0] || {};
        const plist = data[1] || [];
        const initObj = init.torrserver || (init.result && init.result.torrserver) || null;
        const proc = findTorrServerProcess(plist);
        const pid = proc ? +(firstValue(proc, [ 'pid', 'PID' ]) || 0) : null;
        const rss = proc ? +(firstValue(proc, [ 'rss', 'RSS', 'res', 'RES', 'mem_kb' ]) || 0) : 0;
        const cpu = proc ? +(firstValue(proc, [ 'cpu_percent', 'cpu', '%CPU', 'pcpu' ]) || 0) : 0;

        return {
            running: !!proc,
            pid: pid || null,
            bin_present: true,
            init_present: initObj ? true : false,
            config_present: uci.get('torrserver', 'main') != null || true,
            mem_kb: rss,
            ts_cpu: isNaN(cpu) ? '0.0' : cpu.toFixed(1),
            sys_mem: { total: 0, free: 0, available: 0 },
            cores: [],
            fallback_status: true,
            rpc_missing: true
        };
    });
}

function getStatus() {
    return callStatus().catch(function() {
        return fallbackStatus();
    });
}

return view.extend({
    _pollTimer: null,

    load: function() {
        return Promise.all([
            uci.load('torrserver').catch(function() { return null; }),
            getLanIp(),
            getStatus().catch(function() { return {
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
        function currentWebUrl() {
            return buildWebUrl(uci.get('torrserver', 'main', 'port') || port, lanIp);
        }

        const root     = E('div', { class: 'ts-root' });
        const banner   = E('div', { id: 'ts-banner' });
        const errorBox = E('div', { class: 'ts-error', style: 'display:none' });
        const wrap     = E('div', { class: 'ts-wrap' });

        const statusVal = E('div', { class: 'ts-val' }, '...');
        const pidVal    = E('small', { class: 'ts-pid' }, '');
        const ctrlPanel = E('div', { class: 'ts-ctrl' });
        const openBtn   = E('a', {
            class: 'cbi-button cbi-button-neutral ts-webui-btn',
            href: currentWebUrl(),
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Открыть Web UI TorrServer по адресу текущей LuCI-сессии. Если LuCI открыт через VPN/Tailscale, это надёжнее, чем LAN IP.'
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
                    E('span', {}, 'Custom ubus object torrserver не зарегистрирован. Управление будет выполняться через штатный luci.setInitAction; для полного статуса проверьте /usr/libexec/rpcd/torrserver.')
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

            /* Web UI не блокируем из-за сбоя custom RPC: порт может быть доступен,
             * даже если статус получен fallback-методом или не получен вообще. */
            openBtn.href = currentWebUrl();
            const canOpenWeb = st.bin_present !== false && st.init_present !== false;
            if (canOpenWeb) {
                openBtn.classList.remove('disabled');
                openBtn.style.opacity = '1';
                openBtn.style.pointerEvents = '';
                openBtn.title = st.running ? ('Открыть ' + currentWebUrl())
                    : ('Открыть ' + currentWebUrl() + ' — сервис может быть остановлен');
            } else {
                openBtn.classList.add('disabled');
                openBtn.style.opacity = '0.4';
                openBtn.style.pointerEvents = 'none';
                openBtn.title = 'Web UI недоступен: daemon или init script отсутствует';
            }

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
                                ui.addNotification(null, E('p', {}, 'Не удалось выполнить ' + cls + hint), 'danger');
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
                            showError('Ошибка: ' + rpcErrorHint(err));
                            ui.addNotification(null, E('p', {}, 'RPC ошибка: ' + rpcErrorHint(err)), 'danger');
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
                logBox.textContent = 'Лог недоступен: custom ubus object torrserver не зарегистрирован. Для логов используйте logread -e torrserver.';
            });
        }

        function tick() {
            getStatus().then(function(st) {
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

        function row(label, el, help) {
            const labelNode = E('label', { class: 'ts-label' }, [
                label,
                help ? E('span', { class: 'ts-help', title: help, 'data-tip': help, role: 'img', 'aria-label': help }, '?') : ''
            ]);
            return E('div', { class: 'ts-row' }, [
                labelNode,
                E('div', { class: 'ts-field' }, [ el ])
            ]);
        }

        function inp(opt, placeholder, type, min, max, help) {
            const val = uci.get('torrserver', 'main', opt) || '';
            const attrs = {
                class: 'cbi-input-text', type: type || 'text',
                value: val, placeholder: placeholder || '', title: help || '',
                input: function() { uci.set('torrserver', 'main', opt, this.value); }
            };
            if (min !== undefined) attrs.min = String(min);
            if (max !== undefined) attrs.max = String(max);
            return E('input', attrs);
        }

        function chk(opt, def, help) {
            const val = uci.get('torrserver', 'main', opt);
            const checked = val !== undefined ? val === '1' : def === '1';
            return E('input', {
                type: 'checkbox', checked: checked, class: 'ts-chk', title: help || '',
                change: function() { uci.set('torrserver', 'main', opt, this.checked ? '1' : '0'); }
            });
        }

        /* Чекбокс автозапуска — синхронизирует и UCI и rc.d enable/disable */
        function chkAutostart() {
            const val = uci.get('torrserver', 'main', 'enabled');
            const checked = val !== undefined ? val === '1' : true;
            return E('input', {
                type: 'checkbox', checked: checked, class: 'ts-chk',
                title: 'Сохраняет UCI option enabled и синхронизирует /etc/init.d/torrserver enable/disable.',
                change: function() {
                    const en = this.checked;
                    uci.set('torrserver', 'main', 'enabled', en ? '1' : '0');
                    /* Синхронизируем rc.d */
                    (en ? callEnable() : callDisable()).catch(function(err) {
                        ui.addNotification(null, E('p', {}, 'Не удалось изменить автозапуск: ' + rpcErrorHint(err)), 'danger');
                    });
                }
            });
        }

        function sel(opt, options, def, help) {
            const cur = uci.get('torrserver', 'main', opt) || def;
            return E('select', {
                class: 'cbi-input-select', title: help || '',
                change: function() { uci.set('torrserver', 'main', opt, this.value); }
            }, options.map(function(o) {
                const value = Array.isArray(o) ? o[0] : o;
                const text  = Array.isArray(o) ? o[1] : o;
                return E('option', { value: value, selected: value === cur }, text);
            }));
        }

        wrap.appendChild(E('h3', { class: 'ts-section-title' }, 'Основные настройки'));
        wrap.appendChild(row('Автозапуск',         chkAutostart(), 'Включает запуск TorrServer при старте OpenWrt и UCI-флаг enabled.'));
        wrap.appendChild(row('Порт',               inp('port', '8090', 'number', 1, 65535, 'HTTP/Web UI порт TorrServer. После изменения нажмите Применить.'), 'HTTP/Web UI порт TorrServer. Диапазон 1–65535.'));
        wrap.appendChild(row('Рабочая директория', inp('path', '/opt/torrserver', 'text', undefined, undefined, 'Каталог данных TorrServer: база, кеш и служебные файлы.'), 'Каталог данных TorrServer: база, кеш и служебные файлы.'));
        wrap.appendChild(row('Режим прокси',       sel('proxymode', [
            ['tracker', 'tracker — проксировать только tracker-запросы'],
            ['peers',   'peers — проксировать peer-соединения'],
            ['full',    'full — tracker + peers']
        ], 'tracker', 'Режим проксирования TorrServer.'), 'Режим проксирования: tracker, peers или full.'));

        const advBody  = E('div', { style: 'display:none' });
        const advTitle = E('h3', {
            class: 'ts-section-title ts-adv-toggle', style: 'cursor:pointer',
            click: function() {
                advBody.style.display = advBody.style.display === 'none' ? '' : 'none';
                this.textContent = advBody.style.display === 'none'
                    ? '▶ Дополнительные настройки' : '▼ Дополнительные настройки';
            }
        }, '▶ Дополнительные настройки');

        advBody.appendChild(row('IP для bind',         inp('ip', '0.0.0.0', 'text', undefined, undefined, 'Адрес, на котором слушает HTTP сервер. Пусто или 0.0.0.0 — слушать все интерфейсы.'), 'Адрес, на котором слушает HTTP сервер. Пусто или 0.0.0.0 — все интерфейсы.'));
        advBody.appendChild(row('--dontkill',          chk('dontkill', '1', 'Передаёт флаг --dontkill в TorrServer.'), 'Передаёт флаг --dontkill в TorrServer. Оставляйте включённым, если знаете зачем нужен этот режим.'));
        advBody.appendChild(row('HTTP auth',           chk('httpauth', '0', 'Включает встроенную HTTP-авторизацию TorrServer. Может мешать открытию Web UI без настроенных учётных данных.'), 'Встроенная HTTP-авторизация TorrServer. Если включить без учётных данных, Web UI может запрашивать логин.'));
        advBody.appendChild(row('RDB режим',           chk('rdb', '0', 'Включает RDB режим TorrServer.'), 'Включает RDB режим TorrServer. Меняйте только если нужен соответствующий режим базы.'));
        advBody.appendChild(row('Путь к логу',         inp('logpath', '/tmp/torrserver.log', 'text', undefined, undefined, 'Файл логов daemon. Пусто — лог только через stdout/stderr procd/logread.'), 'Файл логов daemon. Пусто — лог через procd/logread.'));
        advBody.appendChild(row('Путь к web-логу',     inp('weblogpath', '/tmp/torrserver-web.log', 'text', undefined, undefined, 'Файл web-логов TorrServer.'), 'Файл web-логов TorrServer.'));
        advBody.appendChild(row('Каталог torrents',    inp('torrentsdir', '/opt/torrserver/torrents', 'text', undefined, undefined, 'Каталог для torrent-файлов.'), 'Каталог для torrent-файлов.'));
        advBody.appendChild(row('Torrent listen addr', inp('torrentaddr', 'example.com:6881', 'text', undefined, undefined, 'Внешний адрес/порт для torrent listener, если требуется явная публикация.'), 'Внешний адрес/порт для torrent listener, если требуется явная публикация.'));
        advBody.appendChild(row('Публичный IPv4',      inp('pubipv4', '', 'text', undefined, undefined, 'Публичный IPv4, если TorrServer должен объявлять фиксированный адрес.'), 'Публичный IPv4, если нужно объявлять фиксированный адрес.'));
        advBody.appendChild(row('Публичный IPv6',      inp('pubipv6', '', 'text', undefined, undefined, 'Публичный IPv6, если TorrServer должен объявлять фиксированный адрес.'), 'Публичный IPv6, если нужно объявлять фиксированный адрес.'));
        advBody.appendChild(row('Web/API поиск',       chk('searchwa', '0', 'Включает Web/API search functionality TorrServer.'), 'Включает Web/API search functionality TorrServer.'));
        advBody.appendChild(row('Макс. размер',        inp('maxsize', '64M', 'text', undefined, undefined, 'Лимит размера в формате, который принимает TorrServer, например 64M.'), 'Лимит размера в формате TorrServer, например 64M.'));
        advBody.appendChild(row('Telegram',            inp('tg', '', 'text', undefined, undefined, 'Параметр Telegram-интеграции TorrServer, если используется.'), 'Параметр Telegram-интеграции TorrServer, если используется.'));
        advBody.appendChild(row('FUSE',                inp('fuse', '', 'text', undefined, undefined, 'Параметр FUSE-монтажа TorrServer, если используется.'), 'Параметр FUSE-монтажа TorrServer, если используется.'));
        advBody.appendChild(row('WebDAV',              chk('webdav', '0', 'Включает WebDAV режим TorrServer.'), 'Включает WebDAV режим TorrServer.'));
        advBody.appendChild(row('Proxy URL',           inp('proxyurl', 'http://127.0.0.1:8080', 'text', undefined, undefined, 'URL внешнего proxy, если выбранный режим прокси должен использовать upstream proxy.'), 'URL внешнего proxy, если выбранный режим прокси должен использовать upstream proxy.'));
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
                            getStatus().then(function(st) {
                                if (st && !st.running && st.bin_present && st.init_present) {
                                    ui.addNotification(null,
                                        E('p', {}, 'Внимание: сервис не запущен после применения настроек.'),
                                        'warning');
                                }
                            }).catch(function() {});
                        }, 1500);
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + rpcErrorHint(e)), 'danger');
                    });
                }
            }, 'Применить'),
            E('button', {
                class: 'cbi-button cbi-button-save',
                click: function() {
                    uci.save().then(function() {
                        ui.addNotification(null, E('p', {}, 'Настройки сохранены.'), 'info');
                    }).catch(function(e) {
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + rpcErrorHint(e)), 'danger');
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
                        ui.addNotification(null, E('p', {}, 'Ошибка: ' + rpcErrorHint(e)), 'danger');
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
            .ts-webui-btn { margin-top: 8px; width: 100%; font-size: 11px; transition: opacity .2s; text-align: center; text-decoration: none; box-sizing: border-box; }
            .ts-log { width: 100%; box-sizing: border-box; background: var(--background-color-low, rgba(0,0,0,.4)); color: var(--text-color-high, #f8f8f2); border-radius: 8px; padding: 10px; font-family: monospace; font-size: 11px; height: 260px; overflow-y: auto; white-space: pre-wrap; border: 1px solid var(--border-color-medium, rgba(255,255,255,.08)); margin-top: 8px; }
            .ts-settings { margin-top: 4px; }
            .ts-section-title { font-size: 13px; font-weight: 600; color: var(--text-color-high, #f5f5f5); margin: 16px 0 8px; border-bottom: 1px solid var(--border-color-medium, rgba(255,255,255,.08)); padding-bottom: 4px; }
            .ts-row   { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; flex-wrap: wrap; }
            .ts-label { width: 220px; flex-shrink: 0; font-size: 13px; color: var(--text-color-high, #f5f5f5); }
            .ts-help { position: relative; display: inline-block; margin-left: 6px; width: 16px; height: 16px; line-height: 16px; text-align: center; border-radius: 50%; background: rgba(127,127,127,.18); color: var(--text-color-medium, #aaa); font-size: 11px; cursor: help; }
            .ts-help:hover::after { content: attr(data-tip); position: absolute; z-index: 9999; left: 20px; top: -8px; width: max-content; max-width: 360px; padding: 8px 10px; border-radius: 6px; background: rgba(20,24,32,.96); border: 1px solid var(--border-color-medium, rgba(255,255,255,.18)); color: var(--text-color-high, #f5f5f5); font-size: 12px; line-height: 1.35; text-align: left; white-space: normal; box-shadow: 0 4px 14px rgba(0,0,0,.35); }
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
