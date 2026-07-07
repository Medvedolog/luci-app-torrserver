# 🎬 TorrServer for OpenWrt + LuCI Companion

> Компактные OpenWrt-пакеты TorrServer + лёгкая LuCI-морда для домашнего роутера.

![OpenWrt](https://img.shields.io/badge/OpenWrt-21--25%2B-00B5E2?logo=openwrt&logoColor=white)
![Packages](https://img.shields.io/badge/packages-IPK%20%2F%20APK-blue)
![Platforms](https://img.shields.io/badge/platforms-aarch64%20%7C%20x86__64-green)
![LuCI](https://img.shields.io/badge/LuCI-companion-orange)
![Status](https://img.shields.io/badge/status-beta-yellow)

Этот репозиторий собирает и публикует готовые пакеты для OpenWrt:

- **`torrserver`** — основной daemon-пакет с бинарником TorrServer и `procd` service.
- **`torrserver-upx`** — вариант daemon-пакета с UPX-сжатым бинарником.
- **`torrserver-official`** — опциональный пакет с официальным upstream binary автора.
- **`luci-app-torrserver`** — лёгкий LuCI companion UI для управления и мониторинга.

Цель проекта: **маленький бинарник**, **нормальный init/procd service**, **IPK/APK релизы** и **простая LuCI-страница без тяжёлых RPC-зависимостей**.

---

## ✨ Что умеет LuCI UI

| Блок | Что показывает |
|---|---|
| 🟢 Service | состояние сервиса, PID, кнопки `Start / Stop / Restart`, переход в Web UI |
| 🧠 RAM | RSS процесса, системная RAM, free/total |
| ⚙️ CPU | CPU процесса TorrServer |
| 📊 Cores | загрузка CPU по ядрам |
| 📜 Log | журнал TorrServer через backend fallback chain |
| 🛠️ Settings | основные и дополнительные UCI-настройки |

UI доступен в меню:

```text
Services → TorrServer
```

---

## 🧱 Архитектура LuCI после рефакторинга

LuCI companion переведён на модель `luci-app-podkop-bot`:

> **Backend решает, frontend рисует.**

### Backend

Основной read-backend — штатный `rpcd` executable plugin:

```text
/usr/libexec/rpcd/luci.torrserver
```

На переходный период также ставится legacy-дубль:

```text
/usr/libexec/rpcd/torrserver
```

Методы:

```sh
/usr/libexec/rpcd/luci.torrserver list
/usr/libexec/rpcd/luci.torrserver call status
/usr/libexec/rpcd/luci.torrserver call log
```

`list` отдаёт:

```json
{"status":{},"log":{}}
```

### Frontend

Frontend больше не парсит чужие raw `ubus`-ответы:

- ❌ нет `luci.getProcessList`
- ❌ нет `luci.getInitList`
- ❌ нет `system.info`
- ❌ нет frontend-конвертации байты/kB
- ❌ нет fallback-эмуляции частичного статуса

В JS остались только:

```js
luci.torrserver.status
luci.torrserver.log
luci.setInitAction
```

Управление сервисом остаётся через штатный LuCI write-path:

```js
rpc.declare({
    object: 'luci',
    method: 'setInitAction',
    params: [ 'name', 'action' ],
    expect: { result: false }
});
```

Это уменьшает write-поверхность собственного backend: `luci.torrserver` отвечает за мониторинг и логи, а start/stop/restart делает стандартный LuCI backend.

---

## 📦 Что собирается в полном релизе

Полный release workflow публикует daemon-пакеты, LuCI companion и контрольные файлы.

### Daemon-пакеты

| Пакет | Binary source | Когда использовать |
|---|---|---|
| `torrserver` | optimized self-build | рекомендуемый вариант по умолчанию |
| `torrserver-upx` | optimized self-build + UPX | когда важен минимальный размер flash/overlay |
| `torrserver-official` | official upstream binary | для provenance/debug или режима `upstream-official` / `both` |

Все daemon-пакеты кладут одинаковые runtime-пути:

```text
/usr/bin/torrserver
/etc/init.d/torrserver
/etc/config/torrserver
```

Поэтому `luci-app-torrserver` работает с любым daemon-вариантом, если эти файлы есть.

### LuCI-пакет

`luci-app-torrserver` содержит:

```text
/www/luci-static/resources/view/torrserver/overview.js
/usr/share/luci/menu.d/luci-app-torrserver.json
/usr/share/rpcd/acl.d/luci-app-torrserver.json
/usr/libexec/rpcd/luci.torrserver
/usr/libexec/rpcd/torrserver        # legacy copy, временно
```

LuCI-пакет **не содержит daemon-бинарник** и **не зависит жёстко от имени daemon-пакета**.

### Контрольные файлы

В релизе также публикуются:

```text
SHA256SUMS.txt
UPSTREAM_BINARY.txt
standalone binaries, если включены workflow-параметрами
```

---

## 🧭 Платформы и форматы пакетов

### OpenWrt 21–24 → IPK

Для OpenWrt 21–24 используйте `.ipk`:

```text
torrserver_<version>_aarch64_generic.ipk
torrserver_<version>_aarch64_cortex-a53.ipk
torrserver_<version>_x86_64.ipk
torrserver-upx_<version>_<arch>.ipk
luci-app-torrserver_<version>_all.ipk
```

### OpenWrt 25+ → APK

Для OpenWrt 25+ используйте `.apk`:

```text
torrserver_<version>_aarch64_generic.apk
torrserver_<version>_aarch64_cortex-a53.apk
torrserver_<version>_x86_64.apk
torrserver-upx_<version>_<arch>.apk
luci-app-torrserver_<version>_noarch.apk
```

### Daemon architecture matrix

| OpenWrt arch | Go target | Binary | Для чего |
|---|---|---|---|
| `aarch64_generic` | `linux/arm64` | arm64 self-build | обычные ARM64 OpenWrt-устройства |
| `aarch64_cortex-a53` | `linux/arm64` | тот же arm64 self-build | ARM64 targets с OpenWrt arch label `aarch64_cortex-a53` |
| `x86_64` | `linux/amd64` | отдельный amd64 self-build | OpenWrt x86_64, mini-PC, VM, bare-metal |

### LuCI architecture

`luci-app-torrserver` не содержит нативного кода:

| Формат | Arch |
|---|---|
| `.ipk` | `all` |
| `.apk` | `noarch` |

---

## 🚀 Быстрая установка

### 1. Установить daemon

Выберите один вариант:

```sh
# OpenWrt 21–24
opkg install ./torrserver_<version>_<arch>.ipk
# или
opkg install ./torrserver-upx_<version>_<arch>.ipk
```

```sh
# OpenWrt 25+
apk add ./torrserver_<version>_<arch>.apk
# или
apk add ./torrserver-upx_<version>_<arch>.apk
```

### 2. Установить LuCI companion

```sh
# OpenWrt 21–24
opkg install ./luci-app-torrserver_<version>_all.ipk
```

```sh
# OpenWrt 25+
apk add ./luci-app-torrserver_<version>_noarch.apk
```

### 3. Перезапустить сервисы web/RPC

```sh
/etc/init.d/rpcd restart
/etc/init.d/uhttpd reload
rm -f /tmp/luci-indexcache /tmp/luci-modulecache/*
```

После этого открыть:

```text
LuCI → Services → TorrServer
```

---

## ✅ Проверка после установки

```sh
ls -l /usr/bin/torrserver
ls -l /etc/init.d/torrserver
ls -l /usr/libexec/rpcd/luci.torrserver

/etc/init.d/torrserver enable
/etc/init.d/torrserver start
/etc/init.d/rpcd restart

ubus -v list luci.torrserver
ubus call luci.torrserver status
ubus call luci.torrserver log
ubus call luci setInitAction '{"name":"torrserver","action":"restart"}'
```

Ожидаемые признаки исправной установки:

- `ubus -v list luci.torrserver` показывает методы `status` и `log`.
- `status.service.running` становится `true` при запущенном daemon.
- `status.proc.available` становится `true` при найденном PID.
- `status.proc.cores` содержит массив загрузки ядер.
- `log.lines` содержит строки TorrServer из `logread` или файлов логов.
- `setInitAction` возвращает `{ "result": true }`.

---

## 🔧 Настройки через LuCI

### Основные

| Поле | Значение |
|---|---|
| `enabled` | автозапуск / soft-enable сервиса |
| `port` | HTTP/Web UI порт TorrServer |
| `path` | рабочая директория данных |
| `proxymode` | режим проксирования: `tracker`, `peers`, `full` |

### Дополнительные

| Поле | Что настраивает |
|---|---|
| `ip` | bind address HTTP server |
| `dontkill` | режим `--dontkill` |
| `httpauth` | встроенная HTTP-авторизация TorrServer |
| `rdb` | RDB режим |
| `logpath` | файл daemon-лога |
| `weblogpath` | файл web-лога |
| `torrentsdir` | каталог `.torrent` файлов |
| `torrentaddr` | внешний listen address |
| `pubipv4` / `pubipv6` | публичные IP |
| `searchwa` | search/web ассистент режим |
| `maxsize` | максимальный размер |
| `tg` | Telegram-интеграция |
| `fuse` | FUSE режим |
| `webdav` | WebDAV режим |
| `proxyurl` | upstream proxy URL |

Подсказки отображаются компактными `?` tooltip'ами рядом с полями.

---

## 🧪 Changelog beta

### Backend / RPC

- ♻️ Переписан LuCI backend на один `rpcd` executable object `luci.torrserver`.
- 🧹 Удалён frontend-парсинг чужих `ubus` форматов.
- 🧠 Метрики CPU/RAM/RSS/per-core считаются в backend по `/proc`.
- 🕒 Добавлен TTL cache для `status` и отдельный CPU delta state.
- 🔐 ACL минимизирован: read только `luci.torrserver` + UCI, write только `luci.setInitAction` + UCI.

### Logs

- 📜 `log` теперь работает через backend fallback chain:
  1. `logread -e torrserver`
  2. `logread -e TorrServer`
  3. `logread | grep -Ei 'torrserver|TorrServer|/usr/bin/torrserver'`
  4. UCI `logpath`
  5. UCI `weblogpath`

### UI/UX

- ⏳ `Start / Stop / Restart` показывают pending-state.
- 🔒 Кнопки блокируются на время операции.
- 🧭 `Stopping...` ждёт исчезновения PID.
- 🧭 `Starting...` ждёт появления PID.
- 🧭 `Restarting...` ждёт смены PID.
- 🧯 Исправлен баг LuCI boolean attributes: больше нет `disabled="false"`.
- 🧩 Tooltip'ы оставлены компактными `?` вместо длинных подписей под полями.
- 🌐 Web UI URL строится от hostname текущей LuCI-сессии.

### Packaging

- 📦 Добавлен `x86_64` fullpack.
- 📦 Собираются `.ipk` и `.apk`.
- 📦 Full workflow собирает daemon + UPX + LuCI в одном релизе.
- 🧪 Standalone LuCI workflow оставлен для быстрых правок интерфейса.
- 📥 Import workflow обновлён под source layout `luci/rpcd/luci.torrserver`.

---

## 🏗️ Как устроены workflow

### Full release workflow

```text
.github/workflows/build_torrserver_apk_ipk.yml
```

Собирает:

- `torrserver`
- `torrserver-upx`
- опционально `torrserver-official`
- `luci-app-torrserver`
- `SHA256SUMS.txt`
- `UPSTREAM_BINARY.txt`

Основные параметры:

| Input | Значения | Назначение |
|---|---|---|
| `version` | `latest`, tag, branch, commit SHA | upstream ref TorrServer |
| `binary_source` | `build-optimized`, `upstream-official`, `both` | источник daemon binary |
| `use_upx` | `true/false` | собирать `torrserver-upx` |
| `include_luci` | `true/false` | приложить LuCI companion |

Рекомендуемый beta-набор:

```text
version: latest
binary_source: build-optimized
use_upx: true
include_luci: true
```

### Standalone LuCI workflow

```text
.github/workflows/Build LuCI App TorrServer Companion.yml
```

Собирает только:

```text
luci-app-torrserver_<version>_all.ipk
luci-app-torrserver_<version>_noarch.apk
SHA256SUMS.txt
```

Использовать, когда менялись только:

- `overview.js`
- `luci.torrserver`
- ACL/menu
- README/metadata LuCI package

---

## 📉 Оптимизация размера бинарника

Основная optimized-сборка использует:

```sh
CGO_ENABLED=0
go build \
  -trimpath \
  -buildvcs=false \
  -tags 'nosqlite' \
  -ldflags='-s -w -checklinkname=0 -buildid='
strip --strip-unneeded torrserver
```

UPX-вариант дополнительно:

```sh
upx --best --lzma torrserver
```

Практически это даёт два варианта:

| Вариант | Приоритет |
|---|---|
| `torrserver` | обычная стабильность и предсказуемость |
| `torrserver-upx` | минимальный размер overlay/flash |

---

## 📚 Upstream и версия

Daemon собирается из официального upstream:

```text
YouROK/TorrServer
```

Workflow умеет брать:

- конкретный tag;
- branch;
- commit SHA;
- `latest`.

Для upstream-тегов вида:

```text
MatriX.142
```

пакетная версия нормализуется в:

```text
142
```

Для нерелизных ref используется dev fallback:

```text
0.0.0-dev.N
```

---

## 🚫 Что не является целью проекта

Проект не пытается:

- заменить upstream TorrServer;
- управлять обновлением самого TorrServer-бинаря из LuCI;
- делать hardened admin panel;
- тащить тяжёлые LuCI/RPC зависимости ради простого мониторинга.

Цель проще:

- компактный TorrServer для OpenWrt;
- нормальный `init.d`/`procd` service;
- пакеты `.ipk`/`.apk`;
- простая домашняя LuCI-морда.

---

## 🪪 License / Upstream notice

TorrServer собирается из официального upstream-репозитория:

```text
YouROK/TorrServer
```

Собственная часть этого репозитория — packaging, workflows и LuCI companion.
