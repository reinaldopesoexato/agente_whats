#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -d data && -s context/state.json ]] || { echo 'Histórico de origem não encontrado.' >&2; exit 1; }
if lsof -nP -iTCP:"${PORT:-3030}" -sTCP:LISTEN >/dev/null 2>&1 || lsof -c Chromium -c 'Google Chrome' -Fn 2>/dev/null | grep -F "n$PWD/data/session-" >/dev/null; then
  echo 'Encerre o WhatsIA no Mac antes de copiar os perfis.' >&2; exit 1
fi
dest=${WHATSIA_SSH:-root@whatsia.psxt.io}
email=${WHATSIA_ADMIN_EMAIL:-reinaldofs95@gmail.com}
[[ "$dest" =~ ^[a-zA-Z0-9._@-]+$ && "$dest" != -* && "$email" =~ ^[a-zA-Z0-9._+%-]+@[a-zA-Z0-9.-]+$ ]] || exit 2
echo "Copiar as contas e o histórico deste Mac para o espaço de $email em $dest?"
read -r -p 'Digite MIGRAR para iniciar: ' confirm
[[ "$confirm" == MIGRAR ]] || exit 1
# OpenSSH reads the password from the terminal, separately from the archive on stdin.
COPYFILE_DISABLE=1 tar --exclude='*/Singleton*' --exclude='*/DevToolsActivePort' --exclude='*/Cache' --exclude='*/Code Cache' \
  -cf - data context | ssh "$dest" "python3 /opt/whatsia/current/import.py '$email'"
