const express=require('express')
const fs=require('node:fs')
const path=require('node:path')
const http=require('node:http')
const {spawn}=require('node:child_process')
const {openStore,permissions,digest,SESSION,error,token,emailAddress}=require('./store')
const {providerBody,publicDefaults,updateDefaults}=require('./broker')

function gateway({dir,runtime,domain,mail=sendMail,provider=fetch}) {
  const store=openStore(dir)
  const {sql}=store
  store.db.exec(`CREATE TABLE IF NOT EXISTS workspaces(hash TEXT PRIMARY KEY,parent TEXT REFERENCES sessions(hash) ON DELETE CASCADE,uid TEXT NOT NULL);`)
  fs.mkdirSync(runtime,{recursive:true})
  const defaultsDir=path.join(runtime,'defaults')
  fs.mkdirSync(defaultsDir,{recursive:true})
  fs.chmodSync(defaultsDir,0o755)
  function publish() {
    const dest=path.join(defaultsDir,'shared.json')
    fs.writeFileSync(dest+'.tmp',JSON.stringify(publicDefaults(store.shared())))
    fs.chmodSync(dest+'.tmp',0o644)
    fs.renameSync(dest+'.tmp',dest)
  }
  publish()
  const origin='https://'+domain
  const app=express()
  app.disable('x-powered-by')
  const rates=new Map()
  const timer=setInterval(()=>{for(const [k,v] of rates) if(v.ends<Date.now()) rates.delete(k)},60000)
  timer.unref()
  function rate(key,count) {
    const v=rates.get(key)
    if(!v||v.ends<=Date.now()) rates.set(key,{n:1,ends:Date.now()+600000})
    else if(++v.n>count) throw error(429,'Aguarde antes de tentar novamente.')
  }
  function cookie(req) {
    const matches=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('__Host-whatsia='))
    return matches.length===1?matches[0].slice(15):''
  }
  const setCookie=(res,value)=>res.cookie('__Host-whatsia',value,{httpOnly:true,secure:true,sameSite:'lax',path:'/',maxAge:SESSION})
  function must(req,perm) {
    if(!req.user) throw error(401,'Entre na sua conta.')
    if(perm&&!store.rights(req.user).includes(perm)) throw error(403,'Permissão insuficiente.')
    return req.user
  }
  function status(id) {
    try{return JSON.parse(fs.readFileSync(path.join(runtime,id+'.json'),'utf8'))}catch{return {}}
  }
  const workspaceSession=(value,id)=>sql('SELECT s.hash AS parent FROM workspaces w JOIN sessions s ON w.parent=s.hash JOIN users u ON s.uid=u.id WHERE w.hash=? AND w.uid=? AND u.id=w.uid AND u.enabled=1 AND s.expires>?').get(digest(value),id,Date.now())
  const json=express.json({limit:'32kb'})
  const mediaJson=express.json({limit:'18mb'})
  app.use((req,res,next)=>{
    res.set({'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Cache-Control':'no-store','X-Frame-Options':'DENY'})
    const host=req.headers.host?.split(':')[0].toLowerCase()
    const central=host===domain
    const id=host?.endsWith('.'+domain)?host.slice(0,-domain.length-1):''
    if(!central && !/^[a-f0-9-]{36}$/.test(id)) return res.sendStatus(404)
    if(!['GET','HEAD'].includes(req.method) && req.headers.origin && req.headers.origin!=='https://'+host) return res.sendStatus(403)
    if(central) {
      if(req.path.startsWith('/shared/')) {
        const broker=req.headers.authorization?.slice(7)
        if(!broker||!sql('SELECT id FROM users WHERE broker=? AND enabled=1').get(broker)) return res.sendStatus(403)
        return mediaJson(req,res,next)
      }
      req.user=store.session(cookie(req));return json(req,res,next)
    }
    const noticeIcon=/^\/notification-icons\/(?:approval|attachment|category|decision|message|task|unanswered|watch)\.png$/.test(req.path)
    if (['GET','HEAD'].includes(req.method) && (noticeIcon || ['/pwa/manifest.webmanifest','/pwa/icon-180.png','/pwa/icon-192.png','/pwa/icon-512.png','/pwa/login.js','/pwa/login.css','/notification-worker.js'].includes(req.path))) {
      return res.sendFile(path.join(__dirname,'../public',req.path))
    }
    if(req.path==='/_mobile-login' && req.method==='POST') {
      if (!req.is('application/json')) return res.sendStatus(415)
      return json(req,res,async err=>{
        if(err) return next(err)
        try {
          rate('login:'+keyFor(req),60)
          const parent=await store.login(req.body.email,req.body.password)
          const user=store.session(parent)
          if(user.id!==id) {
            sql('DELETE FROM sessions WHERE hash=?').run(user.sessionHash)
            throw error(401,'Entre com a conta deste espaço.')
          }
          const value=token()
          sql('INSERT INTO workspaces VALUES(?,?,?)').run(digest(value),user.sessionHash,id)
          setCookie(res,value)
          res.json({ok:true})
        } catch(e){next(e)}
      })
    }
    if(req.path==='/_access') {
      res.set('Content-Security-Policy',"default-src 'none'; script-src 'self'; connect-src 'self'; base-uri 'none'")
      if(req.method==='GET') return res.type('html').send('<meta charset="utf-8"><title>WhatsIA</title><p>Abrindo seu espaço…</p><script src="/_access.js"></script>')
      if(req.method!=='POST'||!req.is('application/json')) return res.sendStatus(415)
      return json(req,res,err=>{
        if(err) return next(err)
        try{
          const value=store.transaction(()=>{
            const t=store.consume(req.body.ticket,'open')
            if(t.uid!==id||!sql('SELECT hash FROM sessions WHERE hash=? AND expires>?').get(t.parent,Date.now())) throw error(403,'Acesso expirado.')
            const key=token()
            sql('INSERT INTO workspaces VALUES(?,?,?)').run(digest(key),t.parent,id)
            return key
          })
          setCookie(res,value);res.json({ok:true})
        }catch(e){next(e)}
      })
    }
    if(req.path==='/_access.js') return res.type('js').send("const ticket=location.hash.slice(1);history.replaceState(null,'','/_access');fetch('/_access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})}).then(r=>location.replace(r.ok?'/':"+JSON.stringify(origin)+"))")
    const session=workspaceSession(cookie(req),id)
    if (!session && req.path==='/' && req.query.app==='1') {
      res.set('Content-Security-Policy',"default-src 'self'; object-src 'none'; base-uri 'none'")
      return res.sendFile(path.join(__dirname,'../public/pwa/login.html'))
    }
    if(!session) return !req.path.startsWith('/api/') && req.accepts(['html','json'])==='html' ? res.redirect(303,origin) : res.status(401).json({error:'Entre novamente no WhatsIA.'})
    if(req.path==='/_mobile-logout' && req.method==='POST') {
      if (!req.is('application/json')) return res.sendStatus(415)
      sql('DELETE FROM sessions WHERE hash=?').run(session.parent)
      res.clearCookie('__Host-whatsia',{path:'/',secure:true,httpOnly:true,sameSite:'lax'})
      return res.json({ok:true})
    }
    if(req.path==='/_account') return res.redirect(303,origin)
    const current=status(id)
    if(!Number.isInteger(current.port)||current.port<1024||current.port>65535||!current.ready) return res.status(503).set({'Retry-After':'5',Refresh:'5'}).send('Seu espaço está iniciando. A página será atualizada em alguns segundos.')
    if(!req.url.startsWith('/')||req.url.startsWith('//')||req.method==='CONNECT') return res.sendStatus(400)
    const headers={host:'127.0.0.1:3030','x-whatsia-worker':sql('SELECT broker FROM users WHERE id=?').get(id).broker}
    if (req.path.startsWith('/api/notifications/push/')) headers['x-whatsia-push-session']=session.parent
    for(const h of ['content-type','content-length','range','accept','last-event-id','if-none-match']) if(req.headers[h]) headers[h]=req.headers[h]
    const upstream=http.request({hostname:'127.0.0.1',port:current.port,method:req.method,path:req.url,headers},reply=>{
      res.status(reply.statusCode)
      for(const h of ['content-type','content-length','content-disposition','content-range','accept-ranges','etag']) if(reply.headers[h]) res.set(h,reply.headers[h])
      if(reply.headers['content-type']?.startsWith('text/event-stream')) {
        const watch=setInterval(()=>{if(!workspaceSession(cookie(req),id)) res.destroy()},5000)
        res.on('close',()=>clearInterval(watch))
        res.flushHeaders()
      }
      reply.on('error',()=>res.destroy());reply.pipe(res)
    })
    upstream.on('error',()=>{if(!res.headersSent) res.status(503).end('Espaço temporariamente indisponível.');else res.destroy()})
    res.on('close',()=>upstream.destroy())
    req.pipe(upstream)
  })
  app.use((req,res,next)=>{
    if(!['GET','HEAD'].includes(req.method)&&!req.is('application/json')) return res.sendStatus(415)
    res.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
    next()
  })
  app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'portal.html')))
  app.get('/portal.js',(_,res)=>res.sendFile(path.join(__dirname,'portal.js')))
  app.get('/portal.css',(_,res)=>res.sendFile(path.join(__dirname,'portal.css')))
  const keyFor=req=>(req.headers['x-real-ip']||req.socket.remoteAddress)
  app.post('/auth/login',async(req,res)=>{
    rate('login:'+keyFor(req),60)
    const value=await store.login(req.body.email,req.body.password)
    setCookie(res,value);res.json({ok:true})
  })
  app.post('/auth/logout',(req,res)=>{
    if(req.user) sql('DELETE FROM sessions WHERE hash=?').run(req.user.sessionHash)
    res.clearCookie('__Host-whatsia',{path:'/',secure:true,httpOnly:true,sameSite:'lax'}).json({ok:true})
  })
  app.post('/auth/request',async(req,res)=>{
    rate('reset:'+keyFor(req),12)
    const email=emailAddress(req.body.email)
    rate('mail:'+email,3)
    if(!process.env.SMTP_HOST && mail===sendMail) throw error(503,'Envio de e-mail indisponível. Contate o operador do servidor.')
    const user=sql('SELECT id FROM users WHERE email=? AND enabled=1').get(email)
    if(user) mail(email,origin+'/#senha='+store.issue(user.id,'password')).catch(()=>console.error('Falha na entrega do e-mail de acesso.'))
    res.json({ok:true})
  })
  app.post('/auth/password',async(req,res)=>{rate('password:'+keyFor(req),20);await store.setPassword(req.body.token,req.body.password);res.json({ok:true})})
  app.post('/auth/open',(req,res)=>{
    const u=must(req)
    res.json({url:'https://'+u.id+'.'+domain+'/_access#'+store.issue(u.id,'open',u.sessionHash)})
  })
  app.get('/me',(req,res)=>{
    const u=must(req),s=status(u.id)
    res.json({email:u.email,permissions:store.rights(u),labels:permissions,quotaGiB:u.quotaGiB,used:s.used??null,ready:!!s.ready})
  })
  app.get('/admin/users',(req,res)=>{
    const u=must(req),rights=store.rights(u)
    if(!rights.some(p=>['users','usage','quota','permissions'].includes(p))) throw error(403,'Permissão insuficiente.')
    res.json(sql('SELECT id,email,enabled,permissions,quotaGiB,revision FROM users ORDER BY email').all().map(row=>({
      id:row.id,revision:row.revision,email:row.email,enabled:!!row.enabled,permissions:rights.includes('permissions')?store.rights(row):undefined,
      quotaGiB:rights.some(p=>p==='quota'||p==='usage')?row.quotaGiB:undefined,used:rights.includes('usage')?(status(row.id).used??null):undefined})))
  })
  app.post('/admin/users',(req,res)=>{must(req,'users');res.status(201).json({id:store.create(req.body.email)})})
  app.patch('/admin/users/:id',(req,res)=>{const {revision,...changes}=req.body;store.update(must(req),req.params.id,changes,revision);res.json({ok:true})})
  require('./admin-skills').registerAdminSkills(app,must,dir)
  app.get('/admin/ai',(req,res)=>{must(req,'ai');res.json(publicDefaults(store.shared()))})
  app.patch('/admin/ai',(req,res)=>{
    must(req,'ai');const shared=updateDefaults(store.shared(),req.body)
    sql('UPDATE shared SET value=? WHERE id=1').run(JSON.stringify(shared));publish();res.json(publicDefaults(shared))
  })
  app.post('/shared/push/sessions',(req,res)=>{
    const sessions=req.body?.sessions
    if (!Array.isArray(sessions)||sessions.length>128||sessions.some(s=>typeof s!=='string'||!/^[a-f0-9]{64}$/.test(s))) return res.sendStatus(400)
    const check=sql('SELECT 1 FROM sessions s JOIN users u ON s.uid=u.id WHERE u.enabled=1 AND u.broker=? AND s.hash=? AND s.expires>?')
    res.json({active:sessions.filter(s=>check.get(req.headers.authorization.slice(7),s,Date.now()))})
  })
  app.post(['/shared/responses','/shared/images/generations'],async(req,res)=>{
    const key=store.shared().apiKey
    if(!key) throw error(503,'A chave compartilhada está desativada.')
    const route=req.path.slice(8)
    const body=providerBody(route,req.body)
    const answer=await provider('https://api.openai.com/v1/'+route,{method:'POST',redirect:'error',signal:AbortSignal.timeout(240000),
      headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body)})
    if(!answer.ok) return res.status(answer.status).json({error:{message:'O provedor recusou a solicitação.'}})
    res.json(await answer.json())
  })
  app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.status&&err.status<500?err.message:'Operação indisponível.'}))
  return {app,store}
}
function sendMail(email,link) {
  return new Promise((resolve,reject)=>{
    const child=spawn('python3',[path.join(__dirname,'mail.py'),email],{stdio:['pipe','ignore','ignore']})
    child.stdin.on('error',()=>{});child.stdin.end(link)
    child.once('error',reject);child.once('exit',code=>code?reject(Error('SMTP')):resolve())
  })
}
if(require.main===module) {
  process.umask(0o077)
  const domain=process.env.WHATSIA_DOMAIN
  if(!domain||!/^[a-z0-9.-]+$/.test(domain)) throw Error('Domínio inválido.')
  const {app}=gateway({domain,dir:'/control',runtime:'/runtime'})
  app.listen(3040,'127.0.0.1')
}
module.exports={gateway}
