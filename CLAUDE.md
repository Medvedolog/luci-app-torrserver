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

### Правильная схема — rpcd ucode

Backend работает через **rpcd**, не через LuCI dispatcher controller.

```
/usr/share/rpcd/ucode/torrserver        ← rpcd backend, chmod 0755, БЕЗ расширения
/usr/share/rpcd/acl.d/luci-app-torrserver.json
/usr/share/luci/menu.d/luci-app-torrserver.json
/www/luci-static/resources/view/torrserver/overview.js
```

**Имя файла = имя ubus объекта.** Файл называется `torrserver` → объект `torrserver` → JS вызывает `object: 'torrserver'`.

### Почему НЕ LuCI controller

`/usr/share/ucode/luci/controller/` — этот путь не используется. Попытки городить `/api/status` маршруты через LuCI dispatcher приводят к HTTP 500 из-за несовместимости форматов модулей.

### Формат rpcd ucode backend

```javascript
// ПРАВИЛЬНО
return {
    status: {
        call: function() { return { running: true, ... }; }
    },
    start: {
        call: function() { return { ok: true }; }
    }
};

// НЕПРАВИЛЬНО — export не работает при загрузке через require()
export function action_status() { ... }
```

### Формат ucode — важные ограничения

```javascript
// ПРАВИЛЬНО
for (let line in split(txt, '\n')) { ... }

// НЕПРАВИЛЬНО — const в for-in не поддерживается в ucode OpenWrt 24.10
for (const line in split(txt, '\n')) { ... }
```

### JS frontend — rpc.declare()

```javascript
'require rpc';

const callStatus = rpc.declare({
    object: 'torrserver',    // = имя rpcd файла
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
  rpcd/torrserver                  ← rpcd ucode backend (без расширения)

.github/workflows/
  Build LuCI App TorrServer Companion.yml   ← собирает luci-app-torrserver
  build_torrserver_apk_ipk.yml              ← собирает daemon пакеты
```

---

## Workflow — LuCI пакет

Ключевые моменты в `Build LuCI App TorrServer Companion.yml`:

```yaml
# Prepare package root
cp luci/rpcd/torrserver root/usr/share/rpcd/ucode/torrserver
chmod 0755 root/usr/share/rpcd/ucode/torrserver

# nfpm contents
- src: ./root/usr/share/rpcd/ucode/torrserver
  dst: /usr/share/rpcd/ucode/torrserver
  file_info:
    mode: 0755
```

`ucode` в `depends` — **не нужен** для rpcd схемы.

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

Если `ubus -v list torrserver` пустой — rpcd не подхватил файл. Проверить права (`chmod 0755`) и имя файла (без расширения).

---

## Частые ошибки — не повторять

| Ошибка | Правильно |
|--------|-----------|
| `export function` в rpcd backend | `return { method: { call: fn } }` |
| `for (const x in ...)` в ucode | `for (let x in ...)` |
| `document.getElementById` в render() | замыкания на переменные элементов |
| путь `/usr/share/luci/view/` | `/www/luci-static/resources/view/` |
| `window.fetch('/api/...')` | `rpc.declare()` |
| LuCI controller для API | rpcd ucode backend |
| `"type": "call"` в menu.d | не нужен, только `"type": "view"` |
| `handler:` в menu.d | не существует, поле называется `module:` |
