const test=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs')
const path=require('node:path')
const os=require('node:os')
const http=require('node:http')
const {gateway}=require('./server')
const {providerBody}=require('./broker')

test('login e isolamento sobrevivem à substituição do portal; permissões e logout valem no servidor',async t=>{
  const base=fs.mkdtempSync(path.join(os.tmpdir(),'whatsia-test-'))
  const domain='whatsia.test'
  const options={dir:path.join(base,'control'),runtime:path.join(base,'runtime'),domain}
  let portal,listener
  async function start() {
    portal=gateway(options)
    listener=http.createServer(portal.app)
    await new Promise(r=>listener.listen(0,'127.0.0.1',r))
  }
  async function stop(){await new Promise(r=>listener.close(r));portal.store.db.close()}
  await start()
  t.after(async()=>{await stop();fs.rmSync(base,{recursive:true,force:true})})
  async function request(route,{method='GET',body,cookie,host=domain,origin,broker}={}) {
    const headers={host,'accept':'application/json'}
    if(body){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(JSON.stringify(body))}
    if(cookie)headers.cookie=cookie
    if(origin)headers.origin=origin
    if(broker)headers.authorization='Bearer '+broker
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:listener.address().port,path:route,method,headers},res=>{
        let data='';res.on('data',b=>data+=b);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,data:()=>JSON.parse(data)}))
      });req.on('error',reject);req.end(body&&JSON.stringify(body))
    })
  }
  async function signup(email,admin=false) {
    const id=portal.store.create(email,admin)
    await portal.store.setPassword(portal.store.issue(id,'password'),'uma senha longa de teste')
    const logged=await request('/auth/login',{method:'POST',body:{email,password:'uma senha longa de teste'}})
    assert.equal(logged.status,200)
    return {cookie:logged.headers['set-cookie'][0].split(';')[0],id}
  }
  const a=await signup('a@example.com',true),b=await signup('b@example.com')
  assert.equal((await request('/admin/users',{cookie:b.cookie})).status,403)
  assert.equal((await request('/admin/users',{cookie:a.cookie})).status,200)
  assert.equal((await request('/admin/users/'+a.id,{method:'PATCH',body:{permissions:[]},cookie:a.cookie})).status,409)
  assert.equal((await request('/admin/users/'+b.id,{method:'PATCH',body:{permissions:['usage']},cookie:a.cookie})).status,200)
  assert.equal((await request('/admin/users',{cookie:b.cookie})).data()[0].permissions,undefined)
  assert.equal((await request('/admin/users/'+b.id,{method:'PATCH',body:{quotaGiB:12},cookie:b.cookie})).status,403)
  assert.equal((await request('/auth/logout',{method:'POST',body:{},origin:'https://other.test',cookie:a.cookie})).status,403)
  const rule={name:'Regra interna',group:'X',instruction:'Registrar prazos',action:'task',active:true}
  for(const method of ['GET','POST','PUT','DELETE']) {
    const path='/admin/skills'+(['PUT','DELETE'].includes(method)?'/qualquer':'')
    assert.equal((await request(path,{method,cookie:b.cookie,body:method==='GET'?undefined:rule})).status,403)
  }
  await request('/admin/users/'+b.id,{method:'PATCH',cookie:a.cookie,body:{permissions:['adminSkills']}})
  assert.equal((await request('/admin/users',{cookie:b.cookie})).status,403)
  const created=await request('/admin/skills',{method:'POST',body:rule,cookie:b.cookie})
  assert.equal(created.status,201)
  const saved=created.data(),route='/admin/skills/'+saved.id
  assert.equal((await request(route,{method:'PUT',body:{...saved,active:false},cookie:b.cookie})).status,200)
  assert.equal((await request(route,{method:'DELETE',body:{revision:1},cookie:b.cookie})).status,409)
  await stop();await start()
  const stored=(await request('/admin/skills',{cookie:b.cookie})).data()
  assert.equal(stored.length,1);assert.equal(stored[0].active,false)
  assert.equal((await request(route,{method:'DELETE',body:{revision:stored[0].revision},cookie:b.cookie})).status,204)
  await request('/admin/users/'+b.id,{method:'PATCH',cookie:a.cookie,body:{permissions:[]}})
  assert.equal((await request('/admin/skills',{cookie:b.cookie})).status,403)
  const ticket=new URL((await request('/auth/open',{method:'POST',body:{},cookie:a.cookie})).data().url).hash.slice(1)
  const host=a.id+'.'+domain
  const ownerBroker=portal.store.sql('SELECT broker FROM users WHERE id=?').get(a.id).broker
  const otherBroker=portal.store.sql('SELECT broker FROM users WHERE id=?').get(b.id).broker
  const mobileBody={email:'a@example.com',password:'uma senha longa de teste'}
  assert.equal((await request('/pwa/manifest.webmanifest',{host})).data().display,'standalone')
  assert.equal((await request('/?app=1',{host})).status,200)
  assert.equal((await request('/_mobile-login',{host:b.id+'.'+domain,method:'POST',body:mobileBody})).status,401)
  const mobile=await request('/_mobile-login',{host,method:'POST',body:mobileBody})
  assert.equal(mobile.status,200)
  const mobileCookie=mobile.headers['set-cookie'][0].split(';')[0]
  const mobileParent=portal.store.sql('SELECT parent FROM workspaces WHERE uid=?').get(a.id).parent
  const allowed=broker=>request('/shared/push/sessions',{broker,method:'POST',body:{sessions:[mobileParent]}})
  assert.deepEqual((await allowed(ownerBroker)).data().active,[mobileParent])
  assert.deepEqual((await allowed(otherBroker)).data().active,[])
  assert.equal((await request('/_mobile-logout',{host,method:'POST',cookie:mobileCookie,body:{}})).status,200)
  assert.deepEqual((await allowed(ownerBroker)).data().active,[])

  assert.equal((await request('/_access',{host:b.id+'.'+domain,method:'POST',body:{ticket}})).status,403)
  const access=await request('/_access',{host,method:'POST',body:{ticket}})
  assert.equal(access.status,200)
  assert.equal((await request('/_access',{host,method:'POST',body:{ticket}})).status,403)
  const workerCookie=access.headers['set-cookie'][0].split(';')[0]
  const fakeWorker=http.createServer((req,res)=>{
    assert.equal(req.headers.cookie,undefined)
    assert.equal(req.headers.host,'127.0.0.1:3030')
    assert.equal(req.headers['x-whatsia-worker'],portal.store.sql('SELECT broker FROM users WHERE id=?').get(a.id).broker)
    res.setHeader('set-cookie','untrusted=1');res.end(JSON.stringify({owner:a.id}))
  })
  await new Promise(r=>fakeWorker.listen(0,'127.0.0.1',r))
  const fixture=path.join(options.runtime,a.id+'.json')
  fs.writeFileSync(fixture,JSON.stringify({port:fakeWorker.address().port,ready:true,used:128}))
  const own=await request('/api/accounts?user='+b.id,{host,cookie:workerCookie})
  assert.equal(own.data().owner,a.id)
  assert.equal(own.headers['set-cookie'],undefined)
  await new Promise(r=>fakeWorker.close(r));fs.unlinkSync(fixture)
  assert.equal((await request('/admin/ai',{method:'PATCH',body:{apiKey:'test-key',chatCloudModel:'test-model'},cookie:a.cookie})).status,200)
  const defaults=(await request('/admin/ai',{cookie:a.cookie})).data()
  assert.equal(defaults.sharedKey,true);assert.equal(defaults.apiKey,undefined)
  assert(!fs.readFileSync(path.join(options.runtime,'defaults/shared.json'),'utf8').includes('test-key'))
  assert.equal((await request('/admin/ai',{cookie:b.cookie})).status,403)
  assert.equal((await request('/api/accounts',{host:b.id+'.'+domain,cookie:workerCookie})).status,401)
  assert.equal((await request('/me',{cookie:workerCookie})).status,401)
  await stop();await start()
  assert.equal((await request('/me',{cookie:a.cookie})).status,200)
  assert.equal((await request('/api/accounts',{host,cookie:workerCookie})).status,503)
  await request('/auth/logout',{method:'POST',body:{},cookie:a.cookie})
  assert.equal((await request('/api/accounts',{host,cookie:workerCookie})).status,401)
})

test('credencial compartilhada só cria requisições sem histórico de outros usuários',()=>{
  const b={model:'modelo',instructions:'Teste',max_output_tokens:100,input:[{role:'user',content:[{type:'input_text',text:'olá'}]}]}
  assert.equal(providerBody('responses',b).store,false)
  for(const extra of [{conversation:'externa'},{previous_response_id:'outra'},{tools:[{}]},{input:[{role:'user',content:[{type:'input_file',file_id:'de-outra-conta'}]}]}])
    assert.throws(()=>providerBody('responses',{...b,...extra}))
})
