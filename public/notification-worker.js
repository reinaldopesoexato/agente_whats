const SHELL = 'whatsia-shell-offline-1'
const home = '/?app=1'
const files = new Set(['/offline-chat.js','/app.js','/style.css','/markdown.js','/whatsia.svg','/chat-wallpaper.svg',
  '/storage.js','/media-viewer.js','/media-viewer.css','/ai-settings.js','/browser-notifications.js',
  '/whatsapp-actions.js','/whatsapp-format.js','/pwa/install.js','/pwa/icon-180.png','/pwa/manifest.webmanifest'])
async function cachedMedia(cache,req) {
  const response = await cache.match(req.url)
  if (!response) return Response.error()
  const range = req.headers.get('Range')
  if (!range) return response
  const match = /^bytes=(\d+)-(\d*)$/.exec(range)
  if (!match) return response
  const blob = await response.blob()
  const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]),blob.size-1) : blob.size-1
  if (start>end || start>=blob.size) return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+blob.size}})
  return new Response(blob.slice(start,end+1),{status:206,headers:{'Content-Type':blob.type,
    'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Content-Range':'bytes '+start+'-'+end+'/'+blob.size}})
}

let preparing
async function prepare() {
  const cache = await caches.open(SHELL)
  const response = await fetch(home,{cache:'no-store',redirect:'error'})
  if (!response.ok) return
  const html = await response.clone().text()
  if (!html.includes('id="chat-view"') || !html.includes('offline-chat.js')) return
  const urls = new Set(['/chat-wallpaper.svg'])
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const url = new URL(match[1],self.location.origin)
    if (url.origin === self.location.origin && files.has(url.pathname)) urls.add(url.href)
  }
  await cache.addAll([...urls].map(url => new Request(url,{cache:'reload',redirect:'error'})))
  await cache.put(home,response)
}
self.addEventListener('install',event=>event.waitUntil(self.skipWaiting()))
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()))
self.addEventListener('message',event=>{
  if (event.data?.action === 'prepare-offline') {
    preparing ||= prepare().finally(()=>{preparing=null})
    event.waitUntil(preparing.catch(()=>{}))
  }
})
self.addEventListener('fetch',event=>{
  const req=event.request, url=new URL(req.url)
  if (req.method!=='GET' || url.origin!==self.location.origin) return
  if (req.mode==='navigate' && url.pathname==='/') {
    event.respondWith((async()=>{
      let response
      try { response=await fetch(req,{cache:'no-store'}) } catch {}
      if (response && ![502,503,504].includes(response.status)) {
        if (response.redirected || [401,403].includes(response.status) ||
            (response.ok && (await response.clone().text()).includes('/pwa/login.js'))) await caches.delete(SHELL)
        return response
      }
      return await caches.match(home,{cacheName:SHELL}) || response || new Response('Abra o WhatsIA uma vez com internet para preparar as conversas offline.',
        {headers:{'Content-Type':'text/plain;charset=utf-8'},status:503})
    })())
  } else if (files.has(url.pathname)) {
    event.respondWith(fetch(req).catch(async()=>await caches.match(req,{cacheName:SHELL}) || Response.error()))
  } else if (/^\/api\/accounts\/[^/]+\/media\/[^/]+$/.test(url.pathname) && url.search==='?preview=1') {
    event.respondWith((async()=>{
      const cache=await caches.open(SHELL)
      try {
        const response=await fetch(req)
        if (response.status===200 && /^(image|audio|video)\//.test(response.headers.get('Content-Type') || '')) {
          try { await cache.put(req.url,response.clone()) } catch {}
        } else if ([401,403,404,410].includes(response.status)) await cache.delete(req)
        return response
      } catch { return cachedMedia(cache,req) }
    })())
  }
})
const displayed=new Set()
async function display({id,notice,silent}) {
  if (!notice || !id || displayed.has(id)) return
  displayed.add(id)
  if (displayed.size>1024) displayed.delete(displayed.values().next().value)
  const types=['message','task','watch','approval','decision','category','attachment','unanswered']
  const icon=types.includes(notice.type)?notice.type:'category'
  try {
    await self.registration.showNotification(notice.title || 'WhatsIA',{
      body:notice.body,silent:silent===true,icon:'/notification-icons/'+icon+'.png',badge:'/pwa/icon-192.png',
      tag:notice.kind+':'+(notice.key||id),data:notice})
  } catch(e){displayed.delete(id);throw e}
}
self.addEventListener('push',event=>{
  let data
  try {data=event.data.json()} catch {}
  event.waitUntil(display(data?.notice?data:{id:'generic',notice:{kind:'test',title:'WhatsIA',body:'Há novidades no seu espaço.'}}))
})
self.addEventListener('message',event=>{
  if(event.data?.action==='notify') event.waitUntil(display(event.data).catch(()=>event.source?.postMessage({action:'notification-error'})))
})
self.addEventListener('pushsubscriptionchange',event=>{
  if (!event.oldSubscription) return
  event.waitUntil((async()=>{
    const subscription=event.newSubscription || await self.registration.pushManager.subscribe(event.oldSubscription.options)
    const response=await fetch('/api/notifications/push/rotate',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({previous:event.oldSubscription.endpoint,subscription:subscription.toJSON()})})
    if (response.status===401 || response.status===404) await subscription.unsubscribe()
  })())
})
self.addEventListener('notificationclick', event => {
  const notice = event.notification.data
  event.notification.close()
  event.waitUntil((async () => {
    if (!notice || notice.kind==='test') {
      const tabs=await self.clients.matchAll({type:'window'})
      if (tabs.length) await tabs[0].focus()
      else await self.clients.openWindow('/?app=1')
      return
    }
    const tabs = await self.clients.matchAll({type:'window',includeUncontrolled:true})
    const app = tabs.find(tab=>new URL(tab.url).pathname === '/')
    if (app) {
      await app.focus()
      app.postMessage({action:'open-notification',notice})
    } else {
      const destination = {kind:notice.kind,account:notice.account,chat:notice.chat,message:notice.message,category:notice.category,key:notice.key}
      await self.clients.openWindow('/?app=1#notice=' + encodeURIComponent(JSON.stringify(destination)))
    }
  })())
})
