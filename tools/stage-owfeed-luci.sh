#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
test -s luci/view/torrserver/overview.js
test -s luci/rpcd/luci.torrserver
mkdir -p dist/root/usr/share/luci/menu.d \
         dist/root/usr/share/rpcd/acl.d \
         dist/root/www/luci-static/resources/view/torrserver \
         dist/root/usr/libexec/rpcd dist/scripts
cp luci/menu.d/luci-app-torrserver.json dist/root/usr/share/luci/menu.d/
cp luci/acl.d/luci-app-torrserver.json dist/root/usr/share/rpcd/acl.d/
cp luci/view/torrserver/overview.js dist/root/www/luci-static/resources/view/torrserver/
install -m 0755 luci/rpcd/luci.torrserver dist/root/usr/libexec/rpcd/luci.torrserver
printf '%s\n' "${LUCI_VERSION:-2.2.0-r1}" > dist/VERSION
cat > dist/scripts/postinst <<'EOF'
#!/bin/sh
[ -n "${IPKG_INSTROOT:-}${APK_INSTROOT:-}" ] && exit 0
/etc/init.d/rpcd restart >/dev/null 2>&1 || true
/etc/init.d/uhttpd reload >/dev/null 2>&1 || true
exit 0
EOF
cat > dist/scripts/prerm <<'EOF'
#!/bin/sh
exit 0
EOF
chmod 0755 dist/scripts/postinst dist/scripts/prerm
