const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const webpush = require('web-push')
const {createPush,validSubscription} = require('./push-delivery')
const {createNotificationFeed}=require('./browser-notifications')
function device(){
  const curve=crypto.createECDH('prime256v1')
  return {endpoint:'https://web.push.apple.com/test-device',keys:{p256dh:curve.generateKeys().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}}
}
test('push valida destino e chaves, preserva preferências e descarta dispositivos expirados',async t=>{
  const sub=device(), dir=fs.mkdtempSync(path.join(os.tmpdir(),'whatsia-push-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  assert(validSubscription(sub))
  assert(!validSubscription({...sub,endpoint:'https://127.0.0.1/example'}))
  assert(!validSubscription({...sub,keys:{p256dh:'x',auth:'x'}}))
  function open(){
    const push=createPush(dir),routes={}
    const app={get:(p,f)=>routes[p]=f,post:(p,f)=>routes[p]=f}
    push.routes(app,()=>{})
    return {push,routes}
  }
  const first=open(), res={json:()=>{},sendStatus:c=>assert.fail(String(c))}
  const preferences={cards:true,messages:true,audience:'groups',account:'a',quiet:true,privateNotice:true}
  first.routes['/api/notifications/push/device']({body:{subscription:sub,preferences}},res)
  const {push}=open()
  const sent=[]
  t.mock.method(webpush,'sendNotification',async(s,p,o)=>{
    assert.equal(webpush.generateRequestDetails(s,p,o).headers['Content-Encoding'],'aes128gcm')
    sent.push(JSON.parse(p))
  })
  const card={kind:'card',title:'Título original',body:'Conteúdo',account:'a'}
  await push.publish('1',{...card,account:'b'})
  await push.publish('2',{kind:'message',chat:'x@c.us'})
  await push.publish('3',card)
  assert.equal(sent.length,1)
  assert.equal(sent[0].notice.title,'WhatsIA');assert(!JSON.stringify(sent).includes('Conteúdo'));assert(sent[0].silent)
  webpush.sendNotification.mock.mockImplementation(async()=>{throw Object.assign(Error(),{statusCode:410})})
  await push.publish('4',card);assert(!open().push.hasCards())
})
test('itens novos em Hoje emitem push mesmo sem uma janela aberta',async t=>{
  const notices=[],items=['antigo']
  const feed=createNotificationFeed(visit=>items.forEach(key=>visit(key,true,()=>({kind:'card',key}))),
    {hasCards:()=>true,publish:async(_,n)=>notices.push(n.key)})
  t.after(()=>feed.close())
  feed.refreshDevices();items.push('novo');feed.changed()
  await new Promise(r=>setTimeout(r,600))
  assert.deepEqual(notices,['novo'])
})
