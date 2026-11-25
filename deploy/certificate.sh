#!/usr/bin/env bash
set -euo pipefail
# Called by install.sh and independently when upgrading an existing site's HTTPS.
conf=/etc/whatsia
scripts=$(cd "$(dirname "$0")" && pwd)
printf '%s\n' "${1:?Informe o e-mail de contato para HTTPS}" > "$conf/acme-email"
install -D -m 755 "$scripts/public-tls.py" /opt/whatsia/tls/public-tls.py
install -d /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/whatsia-reload <<'HOOK'
#!/bin/sh
set -eu
case "${RENEWED_LINEAGE:-}" in
  /etc/letsencrypt/live/whatsia-*) nginx -t && systemctl reload nginx ;;
esac
HOOK
chmod 755 /etc/letsencrypt/renewal-hooks/deploy/whatsia-reload
cat >/etc/systemd/system/whatsia-cert.service <<'UNIT'
[Unit]
Description=Provisionar HTTPS público para o portal e os espaços WhatsIA
After=network-online.target nginx.service
[Service]
Type=oneshot
ExecStart=/opt/whatsia/tls/public-tls.py
TimeoutStartSec=infinity
UNIT
cat >/etc/systemd/system/whatsia-cert.timer <<'UNIT'
[Unit]
Description=Verificar novos espaços do WhatsIA para HTTPS
[Timer]
OnBootSec=30s
OnUnitInactiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now nginx certbot.timer whatsia-cert.timer
systemctl restart whatsia-cert.timer
systemctl start whatsia-cert.service
