const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const webpush = require('web-push')

function validSubscription(sub) {
  try {
    const url = new URL(sub.endpoint)
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
        sub.endpoint.length > 2048 || url.pathname === '/') return false
    if (!(url.hostname === 'fcm.googleapis.com' || url.hostname === 'web.push.apple.com' ||
        url.hostname.endsWith('.push.apple.com') || url.hostname === 'updates.push.services.mozilla.com' ||
        url.hostname.endsWith('.push.services.mozilla.com') || url.hostname.endsWith('.notify.windows.com'))) return false
    const {p256dh, auth} = sub.keys
    if (!/^[\w-]{87}$/.test(p256dh) || !/^[\w-]{22}$/.test(auth)) return false
    crypto.ECDH.convertKey(Buffer.from(p256dh,'base64url'),'prime256v1')
    return true
  } catch {return false}
}

function matches(prefs,notice) {
  if (notice.kind === 'card') return prefs.cards && (prefs.account === 'all' || prefs.account === notice.account)
  const group = notice.chat?.endsWith('@g.us')
  return prefs.messages && !(prefs.audience === 'groups' && !group || prefs.audience === 'people' && group)
}

function createPush(directory) {
  fs.mkdirSync(directory,{recursive:true,mode:0o700})
  const {DatabaseSync} = require('node:sqlite')
  const db = new DatabaseSync(path.join(directory,'devices.sqlite'))
  db.exec('CREATE TABLE IF NOT EXISTS vapid (id INTEGER PRIMARY KEY, keys TEXT NOT NULL); CREATE TABLE IF NOT EXISTS devices(endpoint TEXT PRIMARY KEY, session TEXT NOT NULL, sub TEXT NOT NULL, prefs TEXT NOT NULL)')
  if (!db.prepare('SELECT id FROM vapid WHERE id=1').get()) db.prepare('INSERT OR IGNORE INTO vapid VALUES(1,?)').run(JSON.stringify(webpush.generateVAPIDKeys()))
  const keys = JSON.parse(db.prepare('SELECT keys FROM vapid WHERE id=1').get().keys)
  const tenant = process.env.WHATSIA_TENANT === '1'
  const broker = process.env.WHATSIA_BROKER_URL
  const subject = broker ? new URL(broker).origin : 'mailto:admin@whatsia.psxt.io'
  const devices = new Map(db.prepare('SELECT * FROM devices').all().map(row=>[row.endpoint,
    {session:row.session,sub:JSON.parse(row.sub),prefs:JSON.parse(row.prefs)}]))
  function remove(endpoint,session) {
    if (devices.get(endpoint)?.session !== session) return
    db.prepare('DELETE FROM devices WHERE endpoint=? AND session=?').run(endpoint,session)
    devices.delete(endpoint)
  }
  async function send(target,id,notice) {
    const {sub,prefs} = target
    if (devices.get(sub.endpoint)!==target) return
    const payload = {id,notice:{...notice},silent:prefs.quiet}
    if (prefs.privateNotice) Object.assign(payload.notice,{title:'WhatsIA',body:'Você tem uma nova notificação.'})
    if (Buffer.byteLength(JSON.stringify(payload))>3800) {
      payload.notice={kind:notice.kind,type:notice.type,title:payload.notice.title,body:payload.notice.body,account:notice.account}
    }
    try {
      await webpush.sendNotification(sub,JSON.stringify(payload),{TTL:180,timeout:10000,vapidDetails:{subject,...keys}})
    } catch (e) {
      if ([404,410].includes(e.statusCode)) remove(sub.endpoint,target.session)
      throw e
    }
  }
  async function publish(id,notice) {
    const targets = [...devices.values()].filter(d=>matches(d.prefs,notice))
    if (!targets.length) return
    let active
    if (tenant) {
      const response=await fetch(broker+'/push/sessions',{method:'POST',signal:AbortSignal.timeout(5000),
        headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.WHATSIA_BROKER_TOKEN},
        body:JSON.stringify({sessions:[...new Set(targets.map(d=>d.session))]})})
      if (!response.ok) throw Error('Consulta de sessão indisponível')
      active=new Set((await response.json()).active)
    }
    await Promise.allSettled(targets.map(target=>{
      if (active && !active.has(target.session)) return remove(target.sub.endpoint,target.session)
      return send(target,id,notice)
    }))
  }
  function routes(app,changed) {
    const session=req=>tenant ? req.get('X-WhatsIA-Push-Session') : 'local'
    app.get('/api/notifications/push/key',(_,res)=>res.json({key:keys.publicKey}))
    app.post('/api/notifications/push/device',(req,res)=>{
      const owner=session(req), {subscription:sub,preferences:p}=req.body || {}
      if (!owner) return res.sendStatus(401)
      if (!validSubscription(sub) || !p || typeof p.messages!=='boolean' || typeof p.cards!=='boolean') return res.sendStatus(400)
      if (!p.messages && !p.cards) remove(sub.endpoint,owner)
      else {
        if (devices.size>=128 && !devices.has(sub.endpoint)) return res.sendStatus(429)
        const prefs={messages:p.messages,cards:p.cards,quiet:p.quiet===true,privateNotice:p.privateNotice===true,
          account:typeof p.account==='string'&&p.account.length<=100?p.account:'all',audience:['people','groups'].includes(p.audience)?p.audience:'all'}
        const subscription={endpoint:sub.endpoint,keys:{auth:sub.keys.auth,p256dh:sub.keys.p256dh}}
        db.prepare('INSERT OR REPLACE INTO devices VALUES(?,?,?,?)').run(sub.endpoint,owner,JSON.stringify(subscription),JSON.stringify(prefs))
        devices.set(sub.endpoint,{session:owner,sub:subscription,prefs})
      }
      changed()
      res.json({ok:true})
    })
    app.post('/api/notifications/push/rotate',(req,res)=>{
      const {previous,subscription:sub}=req.body||{}
      const target=devices.get(previous)
      if (!target || target.session!==session(req)) return res.sendStatus(404)
      if (!validSubscription(sub)) return res.sendStatus(400)
      if (sub.endpoint!==previous && devices.has(sub.endpoint)) return res.sendStatus(409)
      const clean={endpoint:sub.endpoint,keys:{auth:sub.keys.auth,p256dh:sub.keys.p256dh}}
      db.prepare('UPDATE devices SET endpoint=?,sub=? WHERE endpoint=? AND session=?')
        .run(clean.endpoint,JSON.stringify(clean),previous,target.session)
      devices.delete(previous)
      devices.set(clean.endpoint,{...target,sub:clean})
      res.json({ok:true})
    })
    app.post('/api/notifications/push/test',async(req,res)=>{
      const device=devices.get(req.body?.endpoint)
      if (!device || device.session!==session(req)) return res.sendStatus(404)
      if (Date.now()-(device.tested||0)<10000) return res.sendStatus(429)
      device.tested=Date.now()
      try {
        await send(device,crypto.randomUUID(),{kind:'test',type:'message',key:'teste',title:'WhatsIA',body:'As notificações deste aparelho estão funcionando.'})
        res.json({accepted:true})
      } catch {res.status(502).json({error:'O serviço de push recusou o teste. Ative os avisos novamente.'})}
    })
  }
  return {routes,publish,hasCards:()=>[...devices.values()].some(d=>d.prefs.cards)}
}
module.exports={createPush,validSubscription,matches}
