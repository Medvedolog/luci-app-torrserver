module("luci.controller.torrserver", package.seeall)

-- FIX: явный require nixio — nixio.fs и os.execute работают везде
local nixio = require "nixio"

function index()
    entry({"admin", "services", "torrserver"}, cbi("torrserver"), _("TorrServer"), 60)
    entry({"admin", "services", "torrserver", "status"},  call("action_status")).leaf  = true
    entry({"admin", "services", "torrserver", "start"},   call("action_start")).leaf   = true
    entry({"admin", "services", "torrserver", "stop"},    call("action_stop")).leaf    = true
    entry({"admin", "services", "torrserver", "restart"}, call("action_restart")).leaf = true
    entry({"admin", "services", "torrserver", "get_log"}, call("action_log")).leaf     = true
end

local function json_out(tbl)
    local http = require "luci.http"
    http.prepare_content("application/json")
    http.write_json(tbl)
end

local function have_exec(path)
    return nixio.fs.access(path, "x")
end

function action_start()
    local sys = require "luci.sys"
    if not have_exec("/etc/init.d/torrserver") then
        return json_out({ ok = false, error = "init script not found: /etc/init.d/torrserver" })
    end
    sys.call("/etc/init.d/torrserver start >/dev/null 2>&1")
    -- FIX: os.execute вместо nixio.nanosleep — гарантированно есть в любой сборке
    os.execute("sleep 1")
    json_out({ ok = true })
end

function action_stop()
    local sys = require "luci.sys"
    if not have_exec("/etc/init.d/torrserver") then
        return json_out({ ok = false, error = "init script not found: /etc/init.d/torrserver" })
    end
    sys.call("/etc/init.d/torrserver stop >/dev/null 2>&1")
    os.execute("sleep 1")
    json_out({ ok = true })
end

function action_restart()
    local sys = require "luci.sys"
    if not have_exec("/etc/init.d/torrserver") then
        return json_out({ ok = false, error = "init script not found: /etc/init.d/torrserver" })
    end
    sys.call("/etc/init.d/torrserver restart >/dev/null 2>&1")
    os.execute("sleep 2")
    json_out({ ok = true })
end

function action_log()
    local sys  = require "luci.sys"
    local http = require "luci.http"

    local log = sys.exec("logread -e torrserver 2>/dev/null | tail -n 200")
    if not log or #log == 0 then
        log = "Лог пуст. Сервис не запущен или сообщения вытеснены другими событиями."
    end

    http.prepare_content("text/plain; charset=utf-8")
    http.write(log)
end

function action_status()
    local sys  = require "luci.sys"
    local json = require "luci.jsonc"

    local bin_present    = have_exec("/usr/bin/torrserver")
    local init_present   = have_exec("/etc/init.d/torrserver")
    local config_present = nixio.fs.access("/etc/config/torrserver")

    local pid = sys.exec("pidof torrserver 2>/dev/null | awk '{print $1}'"
                         ):gsub("%s+", "")

    local data = {
        running        = false,
        pid            = nil,   -- FIX: поле pid теперь возвращается клиенту
        bin_present    = bin_present    and true or false,
        init_present   = init_present   and true or false,
        config_present = config_present and true or false,
        ts_cpu         = "0",
        mem_kb         = 0,
        sys_mem        = { total = 0, free = 0, available = 0 },
        cores          = { 0, 0, 0, 0 },
    }

    if pid and #pid > 0 then
        if sys.call("test -d /proc/" .. pid) == 0 then
            data.running = true
            data.pid     = pid
        else
            pid = nil
        end
    end

    -- /proc/meminfo
    for line in io.lines("/proc/meminfo") do
        local k, v = line:match("([^:]+):%s+(%d+)")
        if k == "MemTotal"     then data.sys_mem.total     = tonumber(v) end
        if k == "MemFree"      then data.sys_mem.free      = tonumber(v) end
        if k == "MemAvailable" then data.sys_mem.available = tonumber(v) end
    end
    if not data.sys_mem.available or data.sys_mem.available == 0 then
        data.sys_mem.available = data.sys_mem.free
    end

    -- /proc/stat snapshot
    local cur_sys = {}
    for line in io.lines("/proc/stat") do
        local key, u, n, s, i = line:match("^(cpu%d*)%s+(%d+)%s+(%d+)%s+(%d+)%s+(%d+)")
        if key then
            cur_sys[key] = {
                total = tonumber(u) + tonumber(n) + tonumber(s) + tonumber(i),
                work  = tonumber(u) + tonumber(n) + tonumber(s),
            }
        end
    end

    -- per-process stats
    local cur_proc_total = 0
    if pid then
        local rss = sys.exec(
            "grep VmRSS /proc/" .. pid .. "/status 2>/dev/null | awk '{print $2}'"
        ):gsub("%s+", "")
        data.mem_kb = tonumber(rss) or 0

        local f = io.open("/proc/" .. pid .. "/stat", "r")
        if f then
            local content = f:read("*l") or ""
            f:close()
            local parts = {}
            for part in content:gmatch("%S+") do parts[#parts + 1] = part end
            cur_proc_total = (tonumber(parts[14]) or 0) + (tonumber(parts[15]) or 0)
        end
    end

    -- delta от предыдущего вызова
    local state_file = "/tmp/ts_monitor_state.json"
    local prev_state = {}
    local f = io.open(state_file, "r")
    if f then
        prev_state = json.parse(f:read("*all")) or {}
        f:close()
    end

    for i = 0, 3 do
        local k = "cpu" .. i
        if cur_sys[k] and prev_state[k] then
            local d_total = cur_sys[k].total - (prev_state[k].total or 0)
            local d_work  = cur_sys[k].work  - (prev_state[k].work  or 0)
            if d_total > 0 then
                data.cores[i + 1] = tonumber(string.format("%.1f", (d_work / d_total) * 100))
            end
        end
    end

    if cur_sys["cpu"] and prev_state["cpu"] and cur_proc_total > 0 and prev_state["proc"] then
        local d_sys_total = cur_sys["cpu"].total - (prev_state["cpu"].total or 0)
        local d_proc      = cur_proc_total        - (prev_state["proc"]     or 0)
        if d_sys_total > 0 then
            local cpu_count = 0
            while cur_sys["cpu" .. cpu_count] do cpu_count = cpu_count + 1 end
            if cpu_count < 1 then cpu_count = 1 end
            data.ts_cpu = string.format("%.1f", (d_proc / d_sys_total) * 100 * cpu_count)
        end
    end

    -- сохраняем snapshot
    local new_state   = cur_sys
    new_state["proc"] = cur_proc_total
    f = io.open(state_file, "w")
    if f then
        f:write(json.stringify(new_state))
        f:close()
    end

    json_out(data)
end
