#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."
dest=${WHATSIA_SSH:-root@whatsia.psxt.io}
domain=${WHATSIA_DOMAIN:-whatsia.psxt.io}
email=${WHATSIA_ADMIN_EMAIL:-reinaldofs95@gmail.com}
[[ "$dest" =~ ^[a-zA-Z0-9._@-]+$ && "$dest" != -* && "$domain" =~ ^[a-z0-9]+([.-][a-z0-9]+)+$ && "$email" =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+$ ]] || exit 2
tmp=$(mktemp -d); remote=
opts=(-o ControlPath="$tmp/ssh" -o ControlMaster=no)
finish(){
  if [[ "$remote" =~ ^/tmp/whatsia-release\.[a-zA-Z0-9]+$ ]]; then ssh "${opts[@]}" "$dest" "rm -rf -- '$remote'" || true; fi
  ssh "${opts[@]}" -O exit "$dest" >/dev/null 2>&1 || true
  rm -rf -- "$tmp"
}
trap finish EXIT
# OpenSSH prompts on the terminal. One encrypted connection carries this release.
ssh -o ControlMaster=yes -o ControlPersist=20m -S "$tmp/ssh" -fNT "$dest"
arch=$(ssh "${opts[@]}" "$dest" uname -m)
case "$arch" in x86_64) platform=linux/amd64;; aarch64|arm64) platform=linux/arm64;; *) echo "Arquitetura desconhecida: $arch" >&2;exit 1;; esac
release=$(date -u +%Y%m%d%H%M%S)-$(openssl rand -hex 3)
for target in control worker; do
  docker buildx build --platform "$platform" --load --target "$target" -t "whatsia-$target:$release" .
done
docker save -o "$tmp/images.tar" "whatsia-control:$release" "whatsia-worker:$release"
remote=$(ssh "${opts[@]}" "$dest" 'mktemp -d /tmp/whatsia-release.XXXXXXXX')
[[ "$remote" =~ ^/tmp/whatsia-release\.[a-zA-Z0-9]+$ ]] || exit 1
scp "${opts[@]}" "$tmp/images.tar" deploy/{install.sh,supervise.py,import.py,certificate.sh,public-tls.py,ollama-shared.sh,ollama-gateway.js} "$dest:$remote/"
ssh -t "${opts[@]}" "$dest" "sudo -n true 2>/dev/null && exec sudo bash '$remote/install.sh' '$domain' '$release' '$email'; exec bash '$remote/install.sh' '$domain' '$release' '$email'"
