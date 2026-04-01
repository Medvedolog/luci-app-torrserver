/**
 * luci-app-torrserver — серверный ucode контроллер
 * Путь: /usr/share/ucode/luci/controller/torrserver.uc
 *
 * Метрики считаются на сервере (чтение /proc напрямую),
 * JS получает готовый JSON — нет зависимости от rpcd file.exec/file.read.
 * Лог: popen("logread -e torrserver") — работает без ограничений rpcd.
 */

'use strict';

import { readfile, popen, open, stat } from 'fs';
import { cursor } from 'uci';

/* ── регистрация маршрутов ── */
export function action_index() {
    /* перенаправляем на основную страницу view */
    include('view/torrserver/overview');
}

/* ── /api/status ── */
export function action_status() {
    const uci = cursor();
    uci.load('torrserver');

    const bin_present  = stat('/usr/bin/torrserver')    != null;
    const init_present = stat('/etc/init.d/torrserver') != null;
    const cfg_present  = stat('/etc/config/torrserver') != null;

    /* PID через pgrep — точнее чем pidof для Go-бинарников */
    let pid = null;
    const pg = popen('pgrep -f /usr/bin/torrserver', 'r');
    if (pg) {
        const line = pg.read('line');
        pid = line ? trim(line) : null;
        pg.close();
    }

    /* проверяем что PID реально живой */
    if (pid && stat('/proc/' + pid) == null) pid = null;

    const data = {
        running:        false,
        pid:            null,
        bin_present:    bin_present,
        init_present:   init_present,
        config_present: cfg_present,
        mem_kb:         0,
        ts_cpu:         '0',
        sys_mem:        { total: 0, free: 0, available: 0 },
        cores:          [0, 0, 0, 0],
    };

    if (pid) {
        data.running = true;
        data.pid     = pid;
    }

    /* /proc/meminfo */
    const meminfo = readfile('/proc/meminfo') || '';
    for (const line of split(meminfo, '\n')) {
        const m = match(line, /^(\w+):\s+(\d+)/);
        if (!m) continue;
        if (m[1] == 'MemTotal')     data.sys_mem.total     = +m[2];
        if (m[1] == 'MemFree')      data.sys_mem.free      = +m[2];
        if (m[1] == 'MemAvailable') data.sys_mem.available = +m[2];
    }
    if (!data.sys_mem.available)
        data.sys_mem.available = data.sys_mem.free;

    /* RSS процесса из /proc/<pid>/status */
    if (pid) {
        const status = readfile('/proc/' + pid + '/status') || '';
        const rm = match(status, /VmRSS:\s+(\d+)/);
        if (rm) data.mem_kb = +rm[1];
    }

    /* /proc/stat — snapshot для delta CPU */
    const stat_txt = readfile('/proc/stat') || '';
    const cur_sys = {};
    for (const line of split(stat_txt, '\n')) {
        const m = match(line, /^(cpu\d*)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
        if (!m) continue;
        const u = +m[2], n = +m[3], s = +m[4], i = +m[5];
        cur_sys[m[1]] = { total: u+n+s+i, work: u+n+s };
    }

    /* /proc/<pid>/stat — jiffies процесса */
    let cur_proc_total = 0;
    if (pid) {
        const pstat = readfile('/proc/' + pid + '/stat') || '';
        const parts = split(pstat, ' ');
        cur_proc_total = (+parts[13] || 0) + (+parts[14] || 0);
    }

    /* читаем предыдущий снимок */
    const state_file = '/tmp/ts_monitor_state.json';
    let prev = {};
    const sf = open(state_file, 'r');
    if (sf) {
        try { prev = json(sf.read('all')) || {}; } catch(e) {}
        sf.close();
    }

    /* per-core delta */
    for (let i = 0; i < 4; i++) {
        const k = 'cpu' + i;
        if (cur_sys[k] && prev[k]) {
            const dt = cur_sys[k].total - (prev[k].total || 0);
            const dw = cur_sys[k].work  - (prev[k].work  || 0);
            if (dt > 0) data.cores[i] = +sprintf('%.1f', (dw / dt) * 100);
        }
    }

    /* CPU процесса */
    if (cur_sys['cpu'] && prev['cpu'] && cur_proc_total && prev['proc']) {
        const d_sys  = cur_sys['cpu'].total - (prev['cpu'].total || 0);
        const d_proc = cur_proc_total        - (prev['proc']     || 0);
        if (d_sys > 0) {
            /* считаем кол-во ядер */
            let ncpu = 0;
            for (let i = 0; i < 16; i++) {
                if (cur_sys['cpu' + i]) ncpu++;
                else break;
            }
            if (ncpu < 1) ncpu = 1;
            data.ts_cpu = sprintf('%.1f', (d_proc / d_sys) * 100 * ncpu);
        }
    }

    /* сохраняем snapshot */
    const ns = cur_sys;
    ns['proc'] = cur_proc_total;
    const wf = open(state_file, 'w');
    if (wf) { wf.write(json(ns)); wf.close(); }

    http.prepare_content('application/json');
    http.write(json(data));
}

/* ── /api/log ── */
export function action_log() {
    /* logread -e torrserver — фильтрует по тегу демона на уровне syslog */
    const p = popen('logread -e torrserver 2>/dev/null | tail -n 200', 'r');
    let out = '';
    if (p) { out = p.read('all') || ''; p.close(); }

    if (!length(trim(out)))
        out = 'Нет событий torrserver в логе.';

    http.prepare_content('text/plain; charset=utf-8');
    http.write(out);
}

/* ── /api/svc/<action> ── */
export function action_svc(action) {
    if (!match(action, /^(start|stop|restart|enable|disable)$/)) {
        http.status(400, 'Bad Request');
        return;
    }
    const ret = system('/etc/init.d/torrserver ' + action + ' >/dev/null 2>&1');
    http.prepare_content('application/json');
    http.write(json({ ok: ret == 0, code: ret }));
}
