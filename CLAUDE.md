# CLAUDE.md — luci-app-torrserver

Контекст проекта для AI-ассистентов. Читать перед любой работой с кодом.

---

## Что это за проект

Два пакета для OpenWrt ARM64:

- **`torrserver`** / **`torrserver-upx`** — daemon-пакет: бинарник, init.d, UCI конфиг
- **`luci-app-torrserver`** — LuCI companion UI: статус, кнопки управления, метрики, лог, UCI настройки

Сборка без Makefile — через GitHub Actions + nfpm.

---

## Целевые платформы

- OpenWrt 24.10.x (ipk + apk)
- OpenWrt 25.12 (apk, пакетный менеджер apk вместо opkg)
- Архитектура: `aarch64_generic`, `aarch64_cortex-a53`

---

## Архитектура LuCI пакета (КРИТИЧНО)

### Правильная схема — лёгкий rpcd exec backend

Backend работает через штатный **rpcd executable plugin**, не через LuCI dispatcher controller и не через rpcd ucode plugin.

```
/usr/libexec/rpcd/torrserver               ← shell rpcd backend, chmod 0755, БЕЗ расширения
/usr/share/rpcd/acl.d/luci-app-torrserver.json
/usr/share/luci/menu.d/luci-app-torrserver.json
/www/luci-static/resources/view/torrserver/overview.js
```

**Имя файла = имя ubus объекта.** Файл называется `torrserver` → объект `torrserver` → JS вызывает `object: 'torrserver'`.

Зависимости LuCI-пакета должны оставаться лёгкими:

```yaml
depends:
  - luci-base
  - rpcd
```

Не добавлять `rpcd-mod-ucode`, `ucode-mod-fs`, `rpcd-mod-file`, если backend остаётся shell exec plugin.

### Почему НЕ LuCI controller

`/usr/share/ucode/luci/controller/` для backend API не используется. Попытки городить `/api/status` маршруты через LuCI dispatcher приводят к лишней сложности и HTTP 500/ACL-регрессиям.

### Формат rpcd exec backend

Файл `/usr/libexec/rpcd/torrserver` — исполняемый POSIX shell script. `rpcd` вызывает его двумя способами:

```sh
/usr/libexec/rpcd/torrserver list
/usr/libexec/rpcd/torrserver call status
```

Минимальный контракт:

```sh
case "$1" in
  list)
    printf '{"status":{},"start":{},"stop":{},"restart":{},"enable":{},"disable":{}}\n'
    ;;
  call)
    case "$2" in
      status) method_status ;;
      start) method_start ;;
      stop) method_stop ;;
      restart) method_restart ;;
      enable) method_enable ;;
      disable) method_disable ;;
    esac
    ;;
esac
```

Методы обязаны печатать валидный JSON в stdout. Не использовать bash-only синтаксис внутри backend: только `/bin/sh`/BusyBox-совместимый код.

### JS frontend — rpc.declare()

```javascript
'require rpc';

const callStatus = rpc.declare({
    object: 'torrserver',
    method: 'status',
    expect: { '': {} }
});
```

Никаких `window.fetch('/admin/services/torrserver/api/...')` — только через `rpc.declare()`.

### LuCI view — detached DOM

`render()` возвращает узел который ещё **не вставлен** в документ. `document.getElementById()` вернёт `null`.

```javascript
// ПРАВИЛЬНО — использовать замыкания
const statusVal = E('div', {}, '...');
function renderStatus(st) {
    statusVal.textContent = st.running ? 'ЗАПУЩЕН' : 'ОСТАНОВЛЕН';
}

// НЕПРАВИЛЬНО
function renderStatus(st) {
    document.getElementById('ts-status').textContent = '...'; // null!
}
```

Для динамических элементов (ядра CPU) использовать `parent.querySelector('[data-x="N"]')`, не `document.getElementById`.

### menu.d формат

```json
{
  "admin/services/torrserver": {
    "title": "TorrServer",
    "order": 60,
    "action": { "type": "view", "path": "torrserver/overview" }
  }
}
```

Никаких `"type": "call"` маршрутов для API — они не нужны при rpcd схеме.

---

## Структура репозитория

```
luci/
  menu.d/luci-app-torrserver.json
  acl.d/luci-app-torrserver.json
  view/torrserver/overview.js
  rpcd/torrserver                  ← shell rpcd exec backend (без расширения)

.github/workflows/
  Build LuCI App TorrServer Companion.yml   ← собирает luci-app-torrserver
  build_torrserver_apk_ipk.yml              ← собирает daemon пакеты
```

---

## Workflow — LuCI пакет

Ключевые моменты в `Build LuCI App TorrServer Companion.yml`:

```yaml
# Prepare package root
cp luci/rpcd/torrserver root/usr/libexec/rpcd/torrserver
chmod 0755 root/usr/libexec/rpcd/torrserver

# nfpm contents
- src: ./root/usr/libexec/rpcd/torrserver
  dst: /usr/libexec/rpcd/torrserver
  file_info:
    mode: 0755
```

`rpcd-mod-ucode`, `ucode-mod-fs`, `rpcd-mod-file` в `depends` — **не нужны** для shell rpcd exec backend.

---

## Workflow — daemon пакет

`build_torrserver_apk_ipk.yml` собирает `torrserver` и `torrserver-upx`.

Ключевые моменты:
- `provides: torrserver-daemon` — оба флейвора предоставляют виртуальный пакет
- `conflicts`/`replaces` — torrserver конфликтует с torrserver-upx и наоборот
- `/etc/config/torrserver` ставится как `type: config|noreplace`
- `/lib/upgrade/keep.d/torrserver` — сохранение конфига при sysupgrade

LuCI пакет **не зависит** жёстко ни от `torrserver`, ни от `torrserver-upx`. Совместимость проверяется runtime через `stat('/usr/bin/torrserver')`.

---

## UCI схема конфига

```
config torrserver 'main'
    option enabled '1'
    option port '8090'
    option path '/opt/torrserver'
    option proxymode 'tracker'
    option dontkill '1'
    option httpauth '0'
    option rdb '0'
    option ip ''
    option logpath ''
    option weblogpath ''
    option torrentsdir ''
    option torrentaddr ''
    option pubipv4 ''
    option pubipv6 ''
    option searchwa '0'
    option maxsize ''
    option tg ''
    option fuse ''
    option webdav '0'
    option proxyurl ''
```

---

## Проверка после установки

```sh
/etc/init.d/rpcd restart
ubus -v list torrserver        # должен показать методы
ubus call torrserver status    # должен вернуть JSON
/etc/init.d/uhttpd restart
```

Если `ubus -v list torrserver` пустой — rpcd не подхватил файл. Проверить путь `/usr/libexec/rpcd/torrserver`, права (`chmod 0755`), shebang `#!/bin/sh` и имя файла без расширения.

---

## Частые ошибки — не повторять

| Ошибка | Правильно |
|--------|-----------|
| ucode backend ради простых shell-проверок | `/usr/libexec/rpcd/torrserver` exec plugin |
| bashisms в rpcd backend | POSIX `/bin/sh` / BusyBox-compatible код |
| `document.getElementById` в render() | замыкания на переменные элементов |
| путь `/usr/share/luci/view/` | `/www/luci-static/resources/view/` |
| `window.fetch('/api/...')` | `rpc.declare()` |
| LuCI controller для API | shell rpcd exec backend |
| `"type": "call"` в menu.d | не нужен, только `"type": "view"` |
| `handler:` в menu.d | не существует, поле называется `module:` |
