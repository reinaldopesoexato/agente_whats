const test = require('node:test')
const assert = require('node:assert/strict')
const {messageDelivery,mergeDelivery} = require('./message-delivery')

test('confirmações avançam e sobrevivem a páginas antigas e à leitura do histórico salvo',()=>{
  const record = {fromMe:true}
  for (const ack of [0,1,2,3,4]) {
    assert.equal(mergeDelivery(record,{fromMe:true,ack}),true)
    assert.equal(record.ack,ack)
  }
  assert.equal(mergeDelivery(record,{fromMe:true,ack:1}),false)
  assert.deepEqual(messageDelivery(JSON.parse(JSON.stringify(record))),{ack:4})
})
test('mensagens recebidas e registros antigos não ganham recibos de envio',()=>{
  assert.deepEqual(messageDelivery({fromMe:false,ack:3}),{})
  for (const ack of [null,undefined,9,'2']) assert.deepEqual(messageDelivery({fromMe:true,ack}),{})
  assert.deepEqual(messageDelivery({}),{})
})
test('mídia encaminhada usa a marca ou a contagem informada pelo WhatsApp',()=>{
  assert.deepEqual(messageDelivery({type:'ptt',isForwarded:false}),{isForwarded:false})
  const record = {fromMe:false}
  assert(mergeDelivery(record,{isForwarded:true}))
  assert.equal(mergeDelivery(record,{isForwarded:false}),false)
  assert.deepEqual(messageDelivery({type:'audio',forwardingScore:3}),{isForwarded:true})
  assert.deepEqual(messageDelivery({forwardingScore:0}),{})
})
