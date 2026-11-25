#!/usr/bin/env bash
# Offline runtime test with disposable users, volumes and Chromium profiles.
set -euo pipefail
image=${1:-whatsia-worker:validation}
prefix="whatsia-test-$(openssl rand -hex 5)"
cleanup(){
  for user in a b;do
    docker rm -f "$prefix-$user" >/dev/null 2>&1 || true
    docker volume rm "$prefix-$user" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
boot(){
  docker run -d --name "$prefix-$1" --network none --user 1000:1000 --cap-drop ALL --read-only \
    --security-opt no-new-privileges --tmpfs /tmp:size=128m --shm-size=128m \
    -v "$prefix-$1:/persist" -e WHATSIA_QUOTA_GIB=10 "$image" >/dev/null
  for attempt in {1..30}; do
    if docker exec "$prefix-$1" node -e "fetch('http://127.0.0.1:3030/internal/health').then(async r=>process.exit((await r.json()).ready?0:1)).catch(()=>process.exit(1))";then return;fi
    sleep 1
  done
  docker logs --tail 10 "$prefix-$1";return 1
}
for user in a b; do
  docker volume create "$prefix-$user" >/dev/null
  docker run --rm --network none --user 0 -v "$prefix-$user:/persist" --entrypoint sh "$image" -ec 'mkdir -p /persist/data /persist/context /persist/home && chown 1000:1000 /persist/data /persist/context /persist/home'
  boot "$user"
  docker exec -i "$prefix-$user" node <<'JS'
const assert = require('node:assert/strict')
const LocalWebCache = require('whatsapp-web.js/src/webCache/LocalWebCache')
const cache = new LocalWebCache()
;(async () => {
  await cache.persist('<html>smoke</html>', '0.0.0')
  assert.equal(await cache.resolve('0.0.0'), '<html>smoke</html>')
})().catch(error => {console.error(error);process.exitCode=1})
JS
done
profile(){
  docker exec -i "$prefix-$1" node - "$2" <<'JS'
const puppeteer=require('puppeteer')
;(async()=>{
  const browser=await puppeteer.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox'],
    userDataDir:'/persist/data/session-validation'})
  try {
    if(process.argv[2]==='write') {
      await browser.setCookie({name:'session-test',value:'local-test',domain:'example.test',path:'/',expires:Math.floor(Date.now()/1000)+3600})
    } else {
      const exists=(await browser.cookies()).some(c=>c.name==='session-test'&&c.value==='local-test')
      if(exists!==(process.argv[2]==='present'))throw Error('Perfil inesperado')
    }
  } finally {await browser.close()}
})().catch(e=>{console.error(e.message);process.exitCode=1})
JS
}
profile a write
profile b absent
docker stop -t 75 "$prefix-a" >/dev/null
docker rm "$prefix-a" >/dev/null
boot a
profile a present
echo 'Dois espaços isolados; o cookie do Chromium sobreviveu à recriação do contêiner.'
