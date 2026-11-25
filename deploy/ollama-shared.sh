#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
model=${1:-qwen3-vl:8b}
[[ $model =~ ^[a-zA-Z0-9_.-]+:[a-zA-Z0-9_.-]+$ && $model != *-cloud ]] || exit 2
base=/etc/whatsia
net=whatsia-ollama-backend
engine=whatsia-ollama-engine
gateway=whatsia-ollama-gateway
exec 8>/var/lib/whatsia/install.lock; flock 8
if [[ -e $base/ollama-image ]]; then echo 'Há um Ollama individual configurado. Migre essa instalação antes de ativar o serviço compartilhado.' >&2; exit 1; fi
docker network inspect "$net" >/dev/null 2>&1 || docker network create "$net" >/dev/null
docker volume create whatsia-ollama-models >/dev/null
if ! docker container inspect "$engine" >/dev/null 2>&1; then
  docker pull ollama/ollama:latest
  image=$(docker image inspect ollama/ollama:latest --format '{{index .RepoDigests 0}}')
  docker run -d --name "$engine" --network "$net" --restart unless-stopped \
    --memory 14g --cpus 6 --cap-drop ALL --security-opt no-new-privileges --read-only \
    --tmpfs /tmp:exec,size=1g --log-opt max-size=2m --log-opt max-file=2 \
    -e OLLAMA_NO_CLOUD=1 -e OLLAMA_CONTEXT_LENGTH=8192 -e OLLAMA_NUM_PARALLEL=1 \
    -e OLLAMA_MAX_LOADED_MODELS=1 -v whatsia-ollama-models:/root/.ollama "$image" >/dev/null
fi
docker start "$engine" >/dev/null
for i in {1..30}; do docker exec "$engine" ollama list >/dev/null 2>&1 && break; sleep 1; done
docker exec "$engine" ollama show "$model" >/dev/null 2>&1 || docker exec "$engine" ollama pull "$model"
if [[ $model == qwen3-vl:8b ]]; then
  vision=qwen3-vl:8b-instruct
  docker exec "$engine" ollama show "$vision" >/dev/null 2>&1 || docker exec "$engine" ollama pull "$vision"
  defaults=/var/lib/whatsia/runtime/defaults
  install -d -m 755 "$defaults"
  printf '%s\n' "$vision" > "$defaults/ollama-vision-model.next"
  chmod 644 "$defaults/ollama-vision-model.next"
  mv "$defaults/ollama-vision-model.next" "$defaults/ollama-vision-model"
fi
install -d -m 755 "$base/ollama-gateway"
install -m 644 ollama-gateway.js "$base/ollama-gateway/server.js.next"
mv "$base/ollama-gateway/server.js.next" "$base/ollama-gateway/server.js"
if docker container inspect "$gateway" >/dev/null 2>&1; then
  docker restart "$gateway" >/dev/null
else
  node_image=$(docker inspect -f '{{.Image}}' whatsia-control)
  docker run -d --name "$gateway" --network "$net" --restart unless-stopped \
    --memory 384m --cpus 1 --read-only --user 1000:1000 --cap-drop ALL \
    --security-opt no-new-privileges --log-opt max-size=1m --log-opt max-file=2 \
    -v "$base/ollama-gateway:/service:ro" "$node_image" node /service/server.js >/dev/null
fi
touch "$base/ollama-shared"
flock -u 8
systemctl start whatsia-users.service
