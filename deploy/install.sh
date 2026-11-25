#!/usr/bin/env bash
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Execute com privilégios administrativos.' >&2; exit 1; }
cd "$(dirname "$0")"
domain=${1:?Informe o domínio}; release=${2:?Informe a versão}; email=${3:?Informe o e-mail inicial}
[[ "$domain" =~ ^[a-z0-9]+([.-][a-z0-9]+)+$ && "$release" =~ ^[a-zA-Z0-9_.-]+$ ]] || exit 2
conf=/etc/whatsia
base=/var/lib/whatsia
mkdir -p "$conf" "$base/control" "$base/runtime" "$base/paused" /opt/whatsia/releases
chmod 700 "$base" "$base/control"
exec 8>"$base/install.lock"; flock 8
if [[ -f "$conf/domain" && $(cat "$conf/domain") != "$domain" ]]; then echo 'O domínio diverge da instalação existente.' >&2; exit 1; fi
command -v apt-get >/dev/null || { echo 'O instalador requer Debian ou Ubuntu com systemd.' >&2; exit 1; }
# Keep an existing web front end intact if another service owns HTTPS.
if ss -H -ltnp 'sport = :443' | grep -q . && ! ss -H -ltnp 'sport = :443' | grep -q nginx; then
  echo 'A porta 443 pertence a outro serviço. Integre o proxy existente antes de instalar.' >&2; exit 1
fi
packages=()
for pair in docker:docker.io nginx:nginx mkfs.ext4:e2fsprogs setquota:quota openssl:openssl python3:python3 curl:curl certbot:certbot; do
  command -v "${pair%:*}" >/dev/null || packages+=("${pair#*:}")
done
if (( ${#packages[@]} )); then apt-get update; DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"; fi
if [[ -f /etc/nginx/conf.d/whatsia.conf && ! -f "$conf/worker-image" && ! -f "$conf/domain" ]]; then
  echo 'Já existe uma configuração Nginx com o nome whatsia.conf. Verifique antes de instalar.' >&2; exit 1
fi
systemctl enable --now docker
docker load -i images.tar >/dev/null
for target in control worker; do docker image inspect "whatsia-$target:$release" >/dev/null; done
dest="/opt/whatsia/releases/$release"
mkdir -p "$dest"
install -m 755 supervise.py import.py certificate.sh public-tls.py ollama-shared.sh "$dest"
install -m 644 ollama-gateway.js "$dest"
printf '%s\n' "$domain" > "$conf/domain"
"$dest/certificate.sh" "$email"
touch "$conf/mail.env"; chmod 600 "$conf/mail.env"
systemctl stop whatsia-users.timer 2>/dev/null || true
# Wait for an in-flight profile migration or reconciliation before touching running containers.
exec 7>"$base/supervision.lock"; flock 7
# Explicitly stopped workers stay stopped through a release (including later timer runs).
while IFS= read -r name; do
  uid=${name#whatsia-u-}
  if [[ "$uid" =~ ^[0-9a-f-]{36}$ && $(docker inspect -f '{{.State.Status}}' "$name") == exited && $(docker inspect -f '{{.State.ExitCode}}' "$name") == 0 ]]; then
    if python3 - "$base/control/accounts.sqlite" "$uid" <<'PY'
import sqlite3,sys
db=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
sys.exit(db.execute('SELECT enabled FROM users WHERE id=?',(sys.argv[2],)).fetchone() != (1,))
PY
    then touch "$base/paused/$uid"; fi
  fi
done < <(docker ps -a --filter name=whatsia-u- --format '{{.Names}}')
ln -sfn "$dest" /opt/whatsia/current.next
mv -Tf /opt/whatsia/current.next /opt/whatsia/current
cat >/etc/systemd/system/whatsia-users.service <<'EOF'
[Unit]
Description=Restabelecer espaços individuais do WhatsIA
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/opt/whatsia/current/supervise.py
TimeoutStartSec=infinity
EOF
cat >/etc/systemd/system/whatsia-users.timer <<'EOF'
[Unit]
Description=Verificar espaços do WhatsIA
[Timer]
OnBootSec=15s
OnUnitInactiveSec=20s
Unit=whatsia-users.service
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
if docker container inspect whatsia-control >/dev/null 2>&1; then
  docker stop -t 30 whatsia-control >/dev/null
  if docker container inspect whatsia-control-previous >/dev/null 2>&1; then docker rm whatsia-control-previous >/dev/null; fi
  docker rename whatsia-control whatsia-control-previous
fi
restore_portal(){
  if docker container inspect whatsia-control >/dev/null 2>&1; then docker rm -f whatsia-control >/dev/null; fi
  if docker container inspect whatsia-control-previous >/dev/null 2>&1; then
    docker rename whatsia-control-previous whatsia-control; docker start whatsia-control >/dev/null
  fi
  flock -u 7
  systemctl start whatsia-users.timer || true
}
trap restore_portal ERR
docker run -d --name whatsia-control --network host --restart unless-stopped --read-only \
  --tmpfs /tmp:size=32m --cap-drop ALL --security-opt no-new-privileges --log-opt max-size=5m --log-opt max-file=2 \
  -e "WHATSIA_DOMAIN=$domain" --env-file "$conf/mail.env" -v "$base/control:/control" -v "$base/runtime:/runtime" \
  "whatsia-control:$release" >/dev/null
for attempt in {1..30}; do
  if curl -fsS -H "Host: $domain" http://127.0.0.1:3040/ >/dev/null; then break; fi
  if ((attempt==30)); then echo 'Falha ao iniciar o portal.' >&2; restore_portal; exit 1; fi
  sleep 1
done
trap - ERR
if docker container inspect whatsia-control-previous >/dev/null 2>&1; then docker rm whatsia-control-previous >/dev/null; fi
printf '%s\n' "whatsia-worker:$release" > "$conf/worker-image.new"
mv "$conf/worker-image.new" "$conf/worker-image"
docker exec whatsia-control node control/bootstrap.js init "$email"
flock -u 7
systemctl enable --now whatsia-users.timer
failure=0
systemctl start whatsia-users.service || failure=1
python3 - "$base/runtime" <<'PY'
import json,pathlib,sys,time
root=pathlib.Path(sys.argv[1])
deadline=time.monotonic()+180
while True:
 states=[(p.stem,json.loads(p.read_text())) for p in root.glob('*.json')]
 waiting=any(d.get('ready') and d.get('accounts',0)>d.get('connected',0)+d.get('attention',0) for _,d in states)
 if not waiting or time.monotonic()>=deadline: break
 time.sleep(5)
for uid,d in states:
 print(uid,'parado' if d.get('paused') else 'ativo' if d.get('ready') else 'pendente',
       'WhatsApp conectado:',d.get('connected',0),'de',d.get('accounts',0),'exigem atenção:',d.get('attention',0))
 for account in d.get('byAccount',[]): print(' ',account['name'], '·',account['status'])
 if d.get('updateFailed'): print('  Atenção: atualização deste espaço pendente.')
PY
echo "Portal disponível em https://$domain"
exit "$failure"
