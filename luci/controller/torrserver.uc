'use strict';

import { readfile, popen, open, stat } from 'fs';

function _trim(s) {
    return s ? trim(s) : '';
}

function _service_running() {
    const p = popen('/etc/init.d/torrserver running >/dev/null 2>&1; echo $?', 'r');
    if (!p)
        return false;

    const out = _trim(p.read('all'));
    p.close();
    return out == '0';
}

function _service_pid() {
    const p = popen('pgrep -f "^/usr/bin/torrserver([[:space:]]|$)" 2>/dev/null | head -n 1', 'r');
    if (!p)
        return null;

    const out = _trim(p.read('all'));
    p.close();

    if (!out || stat('/proc/' + out) == null)
        return null;

    return out;
}

function _read_cpu_snapshot() {
    const stat_txt = readfile('/proc/stat') || '';
    const cur_sys = {};

    for (let line in split(stat_txt, '\n')) {
        const m = match(line, /^(cpu\d*)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
        if (!m)
            continue;

        const u = +m[2], n = +m[3], s = +m[4], i = +m[5];
        cur_sys[m[1]] = { total: u + n + s + i, work: u + n + s };
    }

    return cur_sys;
}

function _read_prev_state(path) {
    let prev = {};
    const sf = open(path, 'r');

    if (!sf)
        return prev;

    try {
        prev = json(sf.read('all')) || {};
    }
    catch (e) {}

    sf.close();
    return prev;
}

export function action_status() {
    const bin_present = stat('/usr/bin/torrserver') != null;
    const init_present = stat('/etc/init.d/torrserver') != null;
    const cfg_present = stat('/etc/config/torrserver') != null;

    const running = init_present ? _service_running() : false;
    const pid = running ? _service_pid() : null;

    const data = {
        running: running,
        pid: pid,
        bin_present: bin_present,
        init_present: init_present,
        config_present: cfg_present,
        mem_kb: 0,
        ts_cpu: '0.0',
        sys_mem: { total: 0, free: 0, available: 0 },
        cores: []
    };

    const meminfo = readfile('/proc/meminfo') || '';
    for (let line in split(meminfo, '\n')) {
        const m = match(line, /^(\w+):\s+(\d+)/);
        if (!m)
            continue;
        if (m[1] == 'MemTotal')
            data.sys_mem.total = +m[2];
        else if (m[1] == 'MemFree')
            data.sys_mem.free = +m[2];
        else if (m[1] == 'MemAvailable')
            data.sys_mem.available = +m[2];
    }
    if (!data.sys_mem.available)
        data.sys_mem.available = data.sys_mem.free;

    let cur_proc_total = 0;
    if (pid) {
        const status = readfile('/proc/' + pid + '/status') || '';
        const rm = match(status, /VmRSS:\s+(\d+)/);
        if (rm)
            data.mem_kb = +rm[1];

        const pstat = readfile('/proc/' + pid + '/stat') || '';
        const parts = split(pstat, ' ');
        cur_proc_total = (+parts[13] || 0) + (+parts[14] || 0);
    }

    const cur_sys = _read_cpu_snapshot();
    const prev = _read_prev_state('/tmp/ts_monitor_state.json');

    for (let i = 0; ; i++) {
        const k = 'cpu' + i;
        if (!cur_sys[k])
            break;

        let pct = 0;
        if (prev[k]) {
            const dt = cur_sys[k].total - (prev[k].total || 0);
            const dw = cur_sys[k].work - (prev[k].work || 0);
            if (dt > 0)
                pct = +sprintf('%.1f', (dw / dt) * 100);
        }
        push(data.cores, pct);
    }

    if (pid && cur_sys['cpu'] && prev['cpu'] && prev['pid'] === pid && prev['proc'] != null) {
        const d_sys = cur_sys['cpu'].total - (prev['cpu'].total || 0);
        const d_proc = cur_proc_total - (prev['proc'] || 0);
        let ncpu = length(data.cores);
        if (ncpu < 1)
            ncpu = 1;
        if (d_sys > 0)
            data.ts_cpu = sprintf('%.1f', (d_proc / d_sys) * 100 * ncpu);
    }

    const ns = cur_sys;
    ns['proc'] = pid ? cur_proc_total : null;
    ns['pid']  = pid;
    const wf = open('/tmp/ts_monitor_state.json', 'w');
    if (wf) {
        wf.write(json(ns));
        wf.close();
    }

    http.prepare_content('application/json');
    http.write(json(data));
}

export function action_log() {
    const p = popen('logread -e torrserver 2>/dev/null | tail -n 200', 'r');
    let out = '';
    if (p) {
        out = p.read('all') || '';
        p.close();
    }

    if (!length(_trim(out)))
        out = 'Нет событий torrserver в логе.';

    http.prepare_content('text/plain; charset=utf-8');
    http.write(out);
}

/* Kill any lingering torrserver processes.
 * Strategy:
 *   1. SIGTERM  — polite, give procd a chance to clean up
 *   2. wait up to 3 s in 300 ms steps
 *   3. SIGKILL  — for anything still alive (zombie parent gone → kernel reaps)
 * Returns true if no processes remain after the sequence. */
function _kill_lingering() {
    /* SIGTERM everyone matching the binary */
    const t = popen(
        'pids=$(pgrep -f "^/usr/bin/torrserver([[:space:]]|$)" 2>/dev/null); ' +
        '[ -n "$pids" ] && kill -TERM $pids 2>/dev/null; echo "$pids"', 'r');
    const pids_term = t ? _trim(t.read('all')) : '';
    if (t) t.close();

    if (!length(pids_term))
        return true;   /* nothing was running */

    /* Poll up to 3 s for clean exit */
    let gone = false;
    for (let i = 0; i < 10; i++) {
        const chk = popen(
            'pgrep -f "^/usr/bin/torrserver([[:space:]]|$)" >/dev/null 2>&1; echo $?', 'r');
        const still = chk ? _trim(chk.read('all')) : '1';
        if (chk) chk.close();
        if (still === '1') { gone = true; break; }
        /* sleep 300 ms via /bin/sh arithmetic loop — no usleep on all targets */
        const sl = popen('sleep 0.3 2>/dev/null || true', 'r');
        if (sl) sl.close();
    }

    if (gone)
        return true;

    /* SIGKILL survivors */
    const k = popen(
        'pids=$(pgrep -f "^/usr/bin/torrserver([[:space:]]|$)" 2>/dev/null); ' +
        '[ -n "$pids" ] && kill -KILL $pids 2>/dev/null; echo $?', 'r');
    if (k) k.close();

    /* Brief settle after SIGKILL */
    const sl2 = popen('sleep 0.3 2>/dev/null || true', 'r');
    if (sl2) sl2.close();

    /* Final check */
    const fin = popen(
        'pgrep -f "^/usr/bin/torrserver([[:space:]]|$)" >/dev/null 2>&1; echo $?', 'r');
    const rc = fin ? _trim(fin.read('all')) : '0';
    if (fin) fin.close();
    return rc === '1';   /* pgrep exit 1 → no match → all gone */
}

export function action_svc(action) {
    if (!match(action, /^(start|stop|restart|enable|disable)$/)) {
        http.status(400, 'Bad Request');
        http.prepare_content('application/json');
        http.write(json({ ok: false, code: 400 }));
        return;
    }

    let ok = false;
    let detail = '';

    if (action === 'stop') {
        /* Graceful procd stop first */
        const p = popen('/etc/init.d/torrserver stop >/dev/null 2>&1; echo $?', 'r');
        const rc = p ? _trim(p.read('all')) : '1';
        if (p) p.close();
        const clean = _kill_lingering();
        ok = clean;
        detail = clean ? 'stopped' : 'lingering_processes';

    } else if (action === 'restart') {
        /* Stop with zombie cleanup, then start fresh */
        const sp = popen('/etc/init.d/torrserver stop >/dev/null 2>&1; echo $?', 'r');
        if (sp) sp.close();
        _kill_lingering();

        /* Small pause so procd resets its respawn counter */
        const sl = popen('sleep 0.5 2>/dev/null || true', 'r');
        if (sl) sl.close();

        const p2 = popen('/etc/init.d/torrserver start >/dev/null 2>&1; echo $?', 'r');
        const rc2 = p2 ? _trim(p2.read('all')) : '1';
        if (p2) p2.close();
        ok = (rc2 === '0');
        detail = ok ? 'restarted' : 'start_failed';

    } else {
        /* start / enable / disable — pass through */
        const p = popen('/etc/init.d/torrserver ' + action + ' >/dev/null 2>&1; echo $?', 'r');
        const rc = p ? _trim(p.read('all')) : '127';
        if (p) p.close();
        ok = (rc === '0');
        detail = action;
    }

    http.prepare_content('application/json');
    http.write(json({ ok: ok, action: action, detail: detail }));
}
