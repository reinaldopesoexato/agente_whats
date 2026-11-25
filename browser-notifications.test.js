const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createNotificationFeed } = require('./browser-notifications')

function subscribe(feed, query, cursor) {
  const response = new EventEmitter()
  const frames = []
  response.set = () => {}
  response.flushHeaders = () => {}
  response.write = text => { frames.push(text); return true }
  response.end = () => response.emit('close')
  feed.subscribe({query,get:()=>cursor},response)
  return {response,frames,notices:()=>frames.filter(frame=>frame.startsWith('id:')).map(frame=>JSON.parse(frame.split('data: ')[1]))}
}

test('baseline silenciosa, categorias ocultas e reconexão ao fluxo de cartões', t => {
  const cards = new Map([['antigo',true],['oculto',false]])
  const feed = createNotificationFeed(visit => {
    for (const [key,visible] of cards) visit(key,visible,()=>({kind:'card',key}))
  })
  t.after(()=>feed.close())
  const first = subscribe(feed,{cards:'1'})
  assert.deepEqual(first.notices(),[])
  const cursor = first.frames.find(frame=>frame.startsWith('event: ready')).match(/id: ([^\n]+)/)[1]
  cards.set('oculto',true)
  cards.set('novo',true)
  cards.set('outro-oculto',false)
  const second = subscribe(feed,{cards:'1'})
  assert.deepEqual(first.notices(),[{kind:'card',key:'novo'}])
  assert.deepEqual(second.notices(),[])
  const reconnect = subscribe(feed,{cards:'1'},cursor)
  assert.deepEqual(reconnect.notices(),[{kind:'card',key:'novo'}])
  feed.publish({kind:'message',key:'m'})
  assert.equal(first.notices().length,1)
})

test('avisos só de mensagens dispensam a leitura dos cartões', t => {
  const feed = createNotificationFeed(()=>assert.fail('Leitura indevida de Hoje'))
  t.after(()=>feed.close())
  const browser = subscribe(feed,{messages:'1'})
  feed.changed()
  feed.publish({kind:'message',key:'m'})
  feed.publish({kind:'card',key:'c'})
  assert.deepEqual(browser.notices(),[{kind:'message',key:'m'}])
})

test('o clique foca uma aba existente ou abre a conversa quando a janela foi fechada', async () => {
  const { runInNewContext } = require('node:vm')
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname,'public','notification-worker.js'),'utf8')
  const handlers = {}, notice = {kind:'message',account:'p',chat:'123@c.us',message:'m'}
  const received = []
  let tabs = [], opened
  runInNewContext(source,{URL,self:{addEventListener:(type,handler)=>{handlers[type]=handler},clients:{
    matchAll:async()=>tabs,openWindow:async url=>{opened=url}
  }}})
  async function click() {
    let task
    handlers.notificationclick({notification:{data:notice,close(){}},waitUntil:p=>{task=p}})
    await task
  }
  await click()
  assert.deepEqual(JSON.parse(decodeURIComponent(opened.split('#notice=')[1])),notice)
  tabs = [{url:'http://127.0.0.1:3030/',focus:async()=>received.push('focus'),postMessage:data=>received.push(data.notice)}]
  await click()
  assert.deepEqual(received,['focus',notice])
})
