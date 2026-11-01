#!/bin/sh
# Stage an already-compiled, architecture-specific TorrServer binary for owfeed.
set -eu
cd "$(dirname "$0")/.."
: "${TORRSERVER_BINARY:?Path to the compiled TorrServer ELF is required}"
: "${OWFEED_ARCH:?OpenWrt architecture is required}"
: "${TORRSERVER_VERSION:?Package version is required}"
test -s "$TORRSERVER_BINARY"
mkdir -p "dist/daemon/root/usr/bin" "dist/daemon/root/etc/init.d" \
         "dist/daemon/root/etc/config" "dist/daemon/scripts"
install -m 0755 "$TORRSERVER_BINARY" "dist/daemon/root/usr/bin/torrserver"
install -m 0755 packaging/torrserver.init "dist/daemon/root/etc/init.d/torrserver"
install -m 0644 packaging/torrserver.uci "dist/daemon/root/etc/config/torrserver"
printf '%s\n' "$TORRSERVER_VERSION" > dist/daemon/VERSION
cat > dist/daemon/scripts/postinst <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}${APK_INSTROOT:-}" ] && exit 0
if [ "$(uci -q get torrserver.main.enabled)" = "1" ]; then
  /etc/init.d/torrserver enable >/dev/null 2>&1 || true
  /etc/init.d/torrserver restart >/dev/null 2>&1 || true
else
  /etc/init.d/torrserver disable >/dev/null 2>&1 || true
  /etc/init.d/torrserver stop >/dev/null 2>&1 || true
fi
exit 0
EOF
cat > dist/daemon/scripts/prerm <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}${APK_INSTROOT:-}" ] && exit 0
/etc/init.d/torrserver stop >/dev/null 2>&1 || true
exit 0
EOF
chmod 0755 dist/daemon/scripts/postinst dist/daemon/scripts/prerm
