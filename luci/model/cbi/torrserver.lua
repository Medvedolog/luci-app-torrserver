m = Map("torrserver", translate("TorrServer"), translate("Панель управления TorrServer"))

local uci = require "luci.model.uci".cursor()
local sys = require "luci.sys"
local dsp = require "luci.dispatcher"
local fs  = require "nixio.fs"

local function safe_num_port(v)
    local p = tonumber(v)
    if not p or p < 1 or p > 65535 then return "8090" end
    return tostring(math.floor(p))
end

local function safe_host(v)
    v = tostring(v or "")
    if v:match("^[%w%._:%-%[%]]+$") then return v end
    return "192.168.1.1"
end

-- экранирование значений для вставки в JS var '...'
local function jsq(s)
    s = tostring(s or "")
    s = s:gsub("\\", "\\\\")
         :gsub("'",  "\\'")
         :gsub('"',  '\\"')
         :gsub("\n", "")
         :gsub("\r", "")
         :gsub("</", "<\\/")
    return s
end

local port   = safe_num_port(uci:get("torrserver", "main", "port") or "8090")
local lan_ip = safe_host(sys.exec("uci -q get network.lan.ipaddr"):gsub("%s+", ""))
local url    = "http://" .. lan_ip .. ":" .. port

local bin_present  = fs.access("/usr/bin/torrserver",    "x")
local init_present = fs.access("/etc/init.d/torrserver", "x")
local cfg_present  = fs.access("/etc/config/torrserver")

local url_status  = dsp.build_url("admin", "services", "torrserver", "status")
local url_start   = dsp.build_url("admin", "services", "torrserver", "start")
local url_stop    = dsp.build_url("admin", "services", "torrserver", "stop")
local url_restart = dsp.build_url("admin", "services", "torrserver", "restart")
local url_log     = dsp.build_url("admin", "services", "torrserver", "get_log")

-- ── Предупреждение если daemon не установлен ──
warn = m:section(TypedSection, "_warn", nil)
warn.anonymous = true

local warning_html = ""
if not bin_present or not init_present then
    -- string.format здесь безопасен: нет CSS-процентов, только %s
    warning_html = string.format(
        '<div style="margin:0 0 16px 0;padding:12px 14px;border-radius:8px;' ..
        'border:1px solid rgba(255,180,0,.45);background:rgba(255,180,0,.10);' ..
        'color:var(--text-color-high,#f5f5f5);">' ..
        '<strong>Нужен установленный TorrServer daemon.</strong><br/>' ..
        'Ожидаются:<br/>' ..
        '<code>/usr/bin/torrserver</code><br/>' ..
        '<code>/etc/init.d/torrserver</code><br/><br/>' ..
        'Текущий статус:<br/>' ..
        'binary: %s<br/>init.d: %s<br/>config: %s</div>',
        bin_present  and "OK" or "<b>MISSING</b>",
        init_present and "OK" or "<b>MISSING</b>",
        cfg_present  and "OK" or "<b>MISSING</b>"
    )
end

w = warn:option(DummyValue, "_warn_box")
w.rawhtml = true
w.value   = warning_html

-- ── Секция мониторинга ──
s = m:section(NamedSection, "main", "torrserver", translate("Мониторинг"))
s.anonymous = true

-- URL-константы вставляются через конкатенацию .. jsq(..) .. прямо в [[ ]].
-- [[ ]] — raw Lua string, % в CSS передаются дословно, экранировать не нужно.
-- string.format здесь НЕ используется — именно поэтому нет проблемы с % в CSS.
local monitor_html = [[
<style>
.ts-wrap{display:flex;flex-wrap:wrap;gap:15px;margin-bottom:20px;align-items:stretch}
.ts-card{
    background:var(--background-color-medium,rgba(255,255,255,.04));
    border:1px solid var(--border-color-medium,rgba(255,255,255,.10));
    border-radius:10px;padding:12px;width:180px;text-align:center;
    box-shadow:0 1px 2px rgba(0,0,0,.15);
    display:flex;flex-direction:column;justify-content:space-between;
    color:var(--text-color-high,#f5f5f5)}
.ts-card.wide{width:250px}
.ts-head{font-size:10px;color:var(--text-color-medium,#aaa);
         text-transform:uppercase;margin-bottom:8px;font-weight:600}
.ts-val-big{font-size:22px;font-weight:bold;
            color:var(--text-color-high,#f5f5f5);line-height:1.2}
.ts-unit{font-size:12px;color:var(--text-color-medium,#aaa);font-weight:normal}
.ts-sub{font-size:11px;color:var(--text-color-medium,#aaa);margin-top:4px}
.ts-pid{font-size:10px;color:var(--text-color-medium,#aaa);margin-top:3px;font-family:monospace}
.mem-bar-bg{background:rgba(255,255,255,.08);height:6px;border-radius:3px;
            overflow:hidden;margin:8px 0 4px}
.mem-bar-fill{background:#2196F3;height:100%;width:0%;transition:width .5s ease-in-out}
.cores-grid{display:flex;gap:6px;height:80px;align-items:flex-end;
            justify-content:center;margin-top:5px}
.core-col{width:22px;display:flex;flex-direction:column;
          align-items:center;height:100%;justify-content:flex-end}
.core-track{width:100%;height:65px;background:rgba(255,255,255,.06);
            position:relative;border-radius:3px;overflow:hidden;
            border:1px solid rgba(255,255,255,.08);
            display:flex;flex-direction:column-reverse}
.core-fill{width:100%;background:#4caf50;height:0%;transition:height .4s ease-out}
.core-num{font-size:10px;color:var(--text-color-medium,#aaa);margin-top:4px;font-weight:bold}
.ctrl-panel{margin-top:15px;display:flex;justify-content:space-between;gap:8px;width:100%}
.btn-action{flex:1;padding:8px 0;border:none;border-radius:4px;color:#fff;
            cursor:pointer;font-size:11px;font-weight:bold;text-transform:uppercase;
            transition:opacity .2s,filter .2s;text-align:center}
.btn-action:hover{opacity:.9}
.btn-start{background-color:#4caf50}
.btn-stop{background-color:#f44336}
.btn-restart{background-color:#ff9800}
.btn-disabled{background-color:#666!important;color:#ddd!important;
              cursor:wait!important;filter:grayscale(100%)}
.log-toggle-btn{margin-top:8px;padding:5px 10px;border:none;border-radius:4px;
                background:rgba(255,255,255,.08);color:var(--text-color-high,#f5f5f5);
                cursor:pointer;font-size:11px;width:100%}
.log-toggle-btn:hover{background:rgba(255,255,255,.15)}
.log-box{width:100%;box-sizing:border-box;margin-top:10px;
         background:rgba(0,0,0,.4);color:#f8f8f2;border-radius:8px;
         padding:10px;font-family:monospace;font-size:11px;
         height:300px;overflow-y:auto;white-space:pre-wrap;display:none;
         border:1px solid rgba(255,255,255,.08);text-align:left}
</style>

<div class="ts-wrap">
    <div class="ts-card">
        <div class="ts-head">Сервис</div>
        <div id="ts_status" class="ts-val-big" style="font-size:16px;">...</div>
        <div class="ts-pid" id="ts_pid"></div>
        <div class="ctrl-panel" id="ctrl_panel"></div>
        <button type="button" class="log-toggle-btn" id="log_toggle_btn"
                onclick="tsToggleLog()">&#9660; Журнал</button>
    </div>
    <div class="ts-card wide">
        <div class="ts-head">Оперативная память</div>
        <div><span id="ts_mem" class="ts-val-big">0</span>
             <span class="ts-unit">MB (TorrServer)</span></div>
        <div class="mem-bar-bg"><div id="mem_bar" class="mem-bar-fill"></div></div>
        <div class="ts-sub" id="mem_details">Free: 0 MB | Total: 0 MB</div>
    </div>
    <div class="ts-card">
        <div class="ts-head">Процессор (TS)</div>
        <div class="ts-val-big">
            <span id="ts_cpu">0</span><span class="ts-unit">%</span>
        </div>
        <div class="ts-sub">Нагрузка процесса</div>
    </div>
    <div class="ts-card">
        <div class="ts-head">Ядра (System)</div>
        <div class="cores-grid">
            <div class="core-col">
                <div class="core-track"><div id="c0" class="core-fill"></div></div>
                <div class="core-num">0</div>
            </div>
            <div class="core-col">
                <div class="core-track"><div id="c1" class="core-fill"></div></div>
                <div class="core-num">1</div>
            </div>
            <div class="core-col">
                <div class="core-track"><div id="c2" class="core-fill"></div></div>
                <div class="core-num">2</div>
            </div>
            <div class="core-col">
                <div class="core-track"><div id="c3" class="core-fill"></div></div>
                <div class="core-num">3</div>
            </div>
        </div>
        <div id="cores_txt" class="ts-sub" style="margin-top:5px;font-size:9px;">
            0% | 0% | 0% | 0%
        </div>
    </div>
</div>

<div id="ts_log" class="log-box"></div>

<script type="text/javascript">
(function() {
    var U_STAT    = ']] .. jsq(url_status)  .. [[';
    var U_START   = ']] .. jsq(url_start)   .. [[';
    var U_STOP    = ']] .. jsq(url_stop)    .. [[';
    var U_RESTART = ']] .. jsq(url_restart) .. [[';
    var U_LOG     = ']] .. jsq(url_log)     .. [[';

    var pendingAction = null;
    var fastPollUntil = 0;
    var logVisible    = false;

    function nowSec()        { return Math.floor(Date.now() / 1000); }
    function setFastPoll(s)  { fastPollUntil = nowSec() + s; }
    function nextPollDelay() { return (nowSec() < fastPollUntil) ? 1000 : 3000; }
    function el(id)          { return document.getElementById(id); }

    function getColor(pct) {
        if (pct > 80) return '#f44336';
        if (pct > 50) return '#ff9800';
        return '#4caf50';
    }

    function setBarHeight(id, pct) {
        var e = el(id);
        if (!e) return;
        var h = Math.min(Math.max(Math.round(pct), 0), 100);
        e.style.height = h + '%';
        e.style.backgroundColor = getColor(h);
    }

    function httpGet(url, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return;
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch(e) {}
            if (cb) cb(xhr, data);
        };
        xhr.send(null);
    }

    function httpGetText(url, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url, true);
        xhr.onreadystatechange = function() {
            if (xhr.readyState !== 4) return;
            if (cb) cb(xhr.responseText || '');
        };
        xhr.send(null);
    }

    /* Кнопки: createElement + addEventListener.
       Нет строк с onclick="srv('...')" — проблема кавычек в атрибутах устранена. */
    function makeBtn(id, cls, label, action) {
        var b = document.createElement('button');
        b.type        = 'button';
        b.id          = id;
        b.className   = 'btn-action ' + cls;
        b.textContent = label;
        b.addEventListener('click', function() { tsrv(action); });
        return b;
    }

    function setButtonsBusy(label) {
        ['btn_start','btn_stop','btn_restart'].forEach(function(id) {
            var b = el(id);
            if (!b) return;
            b.disabled = true;
            b.classList.add('btn-disabled');
        });
        if (pendingAction) {
            var active = el('btn_' + pendingAction);
            if (active) active.textContent = label;
        }
    }

    function clearButtonsBusy() {
        ['btn_start','btn_stop','btn_restart'].forEach(function(id) {
            var b = el(id);
            if (!b) return;
            b.disabled = false;
            b.classList.remove('btn-disabled');
        });
    }

    function renderButtons(running, controlsAllowed) {
        var p = el('ctrl_panel');
        if (!p) return;
        p.innerHTML = '';

        if (!controlsAllowed) {
            var d = document.createElement('button');
            d.type        = 'button';
            d.className   = 'btn-action btn-disabled';
            d.disabled    = true;
            d.textContent = 'Daemon missing';
            p.appendChild(d);
            return;
        }

        if (running) {
            p.appendChild(makeBtn('btn_stop',    'btn-stop',    'Stop',    'stop'));
            p.appendChild(makeBtn('btn_restart', 'btn-restart', 'Restart', 'restart'));
        } else {
            p.appendChild(makeBtn('btn_start', 'btn-start', 'Start', 'start'));
        }

        if (pendingAction === 'start')   setButtonsBusy('Starting...');
        if (pendingAction === 'stop')    setButtonsBusy('Stopping...');
        if (pendingAction === 'restart') setButtonsBusy('Restarting...');
    }

    function tsrv(action) {
        pendingAction = action;
        setFastPoll(15);
        renderButtons(false, true);

        if (action === 'start')   setButtonsBusy('Starting...');
        if (action === 'stop')    setButtonsBusy('Stopping...');
        if (action === 'restart') setButtonsBusy('Restarting...');

        var url = action === 'start' ? U_START
                : action === 'stop'  ? U_STOP
                :                      U_RESTART;

        httpGet(url, function(xhr, data) {
            if (data && data.ok === false) {
                pendingAction = null;
                clearButtonsBusy();
                forceUpdate();
                return;
            }
            setTimeout(forceUpdate, 600);
            setTimeout(forceUpdate, 1400);
            setTimeout(forceUpdate, 2800);
        });
    }

    /* tsToggleLog в window scope — доступна из onclick="tsToggleLog()" в HTML выше */
    window.tsToggleLog = function() {
        var box = el('ts_log');
        var btn = el('log_toggle_btn');
        if (!box) return;
        logVisible = !logVisible;
        box.style.display = logVisible ? 'block' : 'none';
        if (btn) btn.textContent = (logVisible ? '\u25b2' : '\u25bc') + ' \u0416\u0443\u0440\u043d\u0430\u043b';
        if (logVisible) fetchLog();
    };

    function fetchLog() {
        var box = el('ts_log');
        if (!box) return;
        box.textContent = 'Загрузка лога...';
        httpGetText(U_LOG, function(text) {
            box.textContent = text || 'Нет данных.';
            box.scrollTop = box.scrollHeight;
        });
    }

    function updateUI(data) {
        if (!data) return;

        var controlsAllowed = !!(data.bin_present && data.init_present);
        var s = el('ts_status');
        var p = el('ts_pid');

        if (!controlsAllowed) {
            if (s) s.innerHTML = '<span style="color:#ffb74d">НЕТ DAEMON</span>';
            if (p) p.textContent = '';
            renderButtons(false, false);
            el('ts_mem').textContent = '0';
            el('ts_cpu').textContent = '0';
            el('mem_bar').style.width = '0%';
            pendingAction = null;
            return;
        }

        if (data.running) {
            if (s) s.innerHTML = '<span style="color:#4caf50">ЗАПУЩЕН</span>';
            if (p) p.textContent = data.pid ? 'PID: ' + data.pid : '';
            renderButtons(true, true);
            el('ts_mem').textContent = (data.mem_kb / 1024).toFixed(1);
            el('ts_cpu').textContent = data.ts_cpu;
        } else {
            if (p) p.textContent = '';
            if (pendingAction === 'stop') {
                if (s) s.innerHTML = '<span style="color:#ff9800">STOPPING...</span>';
            } else if (pendingAction === 'start' || pendingAction === 'restart') {
                if (s) s.innerHTML = '<span style="color:#ff9800">STARTING...</span>';
            } else {
                if (s) s.innerHTML = '<span style="color:#f44336">ОСТАНОВЛЕН</span>';
            }
            renderButtons(false, true);
            el('ts_mem').textContent = '0';
            el('ts_cpu').textContent = '0';
            el('mem_bar').style.width = '0%';
        }

        if (data.sys_mem && data.sys_mem.total > 0) {
            var freeMb  = (data.sys_mem.available / 1024).toFixed(0);
            var totalMb = (data.sys_mem.total      / 1024).toFixed(0);
            el('mem_details').textContent = 'Free: ' + freeMb + ' MB | Total: ' + totalMb + ' MB';
            if (data.running) {
                var pct = (data.mem_kb / data.sys_mem.total) * 100;
                el('mem_bar').style.width = Math.max(pct, 1) + '%';
            }
        }

        var txt = [];
        if (data.cores) {
            for (var i = 0; i < 4; i++) {
                var val = parseFloat(data.cores[i]) || 0;
                setBarHeight('c' + i, val);
                txt.push(Math.round(val) + '%');
            }
        }
        el('cores_txt').textContent = txt.join(' | ');

        if (pendingAction === 'start'   && data.running)  pendingAction = null;
        if (pendingAction === 'restart' && data.running)  pendingAction = null;
        if (pendingAction === 'stop'    && !data.running) pendingAction = null;
        if (!pendingAction) clearButtonsBusy();
    }

    function forceUpdate() {
        httpGet(U_STAT, function(xhr, data) { updateUI(data); });
    }

    function schedulePoll() {
        setTimeout(function() { forceUpdate(); schedulePoll(); }, nextPollDelay());
    }

    /* Запуск после готовности DOM */
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function() {
            forceUpdate();
            schedulePoll();
        });
    } else {
        forceUpdate();
        schedulePoll();
    }

})();
</script>
]]

st = s:option(DummyValue, "_monitor")
st.rawhtml = true
st.value   = monitor_html

-- ── Настройки ──
conf = m:section(NamedSection, "main", "torrserver", translate("Настройки"))
conf.anonymous = true
conf:tab("basic",    translate("Основные"))
conf:tab("advanced", translate("Дополнительные"))

-- string.format здесь безопасен: нет CSS-процентов в этой строке
local btn_html = string.format(
    '<input type="button" class="cbi-button cbi-button-apply" ' ..
    'value="Открыть TorrServer Web UI" onclick="window.open(\'%s\',\'_blank\')" />',
    jsq(url)
)
btn = conf:taboption("basic", DummyValue, "_webui", translate("Веб-интерфейс"))
btn.rawhtml = true
btn.value   = btn_html

e = conf:taboption("basic", Flag, "enabled", translate("Автозапуск"))
e.rmempty = false
e.default = "1"

e = conf:taboption("basic", Value, "port", translate("Порт веб-интерфейса"))
e.datatype = "port"
e.default  = "8090"

e = conf:taboption("basic", Value, "path", translate("Рабочая директория"))
e.placeholder = "/opt/torrserver"

e = conf:taboption("basic", ListValue, "proxymode", translate("Режим прокси"))
e:value("tracker", "tracker")
e:value("all",     "all")
e:value("off",     "off")
e.default = "tracker"

-- ── Дополнительные ──
adv = conf:taboption("advanced", Value, "ip", translate("IP для bind"))
adv.placeholder = "0.0.0.0"
adv.datatype    = "ipaddr"
adv.optional    = true

adv = conf:taboption("advanced", Flag, "dontkill",
    translate("Не завершать по обычному stop-сигналу (--dontkill)"))
adv.rmempty = false
adv.default = "1"

adv = conf:taboption("advanced", Flag, "httpauth", translate("Включить HTTP auth"))
adv.rmempty = false

adv = conf:taboption("advanced", Flag, "rdb", translate("RDB режим"))
adv.rmempty = false

adv = conf:taboption("advanced", Value, "logpath", translate("Путь к основному логу"))
adv.placeholder = "/tmp/torrserver.log"

adv = conf:taboption("advanced", Value, "weblogpath", translate("Путь к web-логу"))
adv.placeholder = "/tmp/torrserver-web.log"

adv = conf:taboption("advanced", Value, "torrentsdir", translate("Каталог .torrent файлов"))
adv.placeholder = "/opt/torrserver/torrents"

adv = conf:taboption("advanced", Value, "torrentaddr", translate("Внешний адрес torrent listen"))
adv.placeholder = "example.com:6881"

adv = conf:taboption("advanced", Value, "pubipv4", translate("Публичный IPv4"))
adv.datatype = "ip4addr"
adv.optional = true

adv = conf:taboption("advanced", Value, "pubipv6", translate("Публичный IPv6"))
adv.datatype = "ip6addr"
adv.optional = true

adv = conf:taboption("advanced", Flag, "searchwa", translate("Включить web/api поиск"))
adv.rmempty = false

adv = conf:taboption("advanced", Value, "maxsize", translate("Макс. размер файла / кеша"))
adv.placeholder = "64M"
adv.datatype    = "string"

adv = conf:taboption("advanced", Value, "tg", translate("Telegram token/chat или tg-параметр"))
adv.datatype = "string"
adv.optional = true

adv = conf:taboption("advanced", Value, "fuse", translate("FUSE опции / mountpoint"))
adv.datatype = "string"
adv.optional = true

adv = conf:taboption("advanced", Flag, "webdav", translate("Включить WebDAV"))
adv.rmempty = false

adv = conf:taboption("advanced", Value, "proxyurl", translate("Upstream proxy URL"))
adv.placeholder = "http://127.0.0.1:8080"
adv.datatype    = "string"
adv.optional    = true

return m
