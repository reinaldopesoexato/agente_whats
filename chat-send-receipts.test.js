const test = require('node:test')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { mkdtempSync, rmSync } = require('node:fs')
const { join } = require('node:path')
const { tmpdir } = require('node:os')
const { createSendReceipts } = require('./chat-send-receipts')

test('envio offline usa um único recibo durante chamadas concorrentes e após reiniciar', async t => {
  const dir = mkdtempSync(join(tmpdir(),'whatsia-receipts-'))
  t.after(() => rmSync(dir,{recursive:true,force:true}))
  const path = join(dir,'receipts.sqlite')
  const token = randomUUID()
  let sends = 0
  const send = async () => ({id:String(++sends),fromMe:true,timestamp:1000,type:'chat'})
  let deliver = createSendReceipts(path)
  const args = [token,'conta','grupo',{body:'Olá'},send]
  const results = await Promise.all([deliver(...args),deliver(...args)])
  deliver = createSendReceipts(path)
  assert.equal((await deliver(...args)).id,'1')
  assert.equal(results[0].id,results[1].id)
  await assert.rejects(deliver(token,'outra','grupo',{body:'Olá'},send),{status:400})
  assert.equal(sends,1)
})
test('uma falha após chamar o WhatsApp exige conferir o envio',async () => {
  const deliver = createSendReceipts(':memory:')
  const token = randomUUID()
  let calls = 0
  const send = () => { calls++; throw Error('conexão interrompida') }
  for (let i=0;i<2;i++) await assert.rejects(deliver(token,'a','b',{},send),{code:'unconfirmed'})
  assert.equal(calls,1)
})
