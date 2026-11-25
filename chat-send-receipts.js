const { DatabaseSync } = require('node:sqlite')
const { createHash } = require('node:crypto')

// Claim a client token durably before calling WhatsApp. An interrupted call may
// already have reached the phone, so an unfinished claim must never send again.
function createSendReceipts(path) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE IF NOT EXISTS receipts (token TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT)')
  const claim = db.prepare('INSERT OR IGNORE INTO receipts(token,fingerprint) VALUES (?,?)')
  const lookup = db.prepare('SELECT fingerprint,result FROM receipts WHERE token=?')
  const complete = db.prepare('UPDATE receipts SET result=? WHERE token=?')
  const active = new Map()
  return async function deliver(token,account,chat,payload,send) {
    if (token === undefined) return send()
    if (typeof token !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(token))
      throw Object.assign(Error('Identificador de envio inválido.'),{status:400})
    const signature = createHash('sha256').update(JSON.stringify([account,chat,payload])).digest('hex')
    if (!claim.run(token,signature).changes) {
      const previous = lookup.get(token)
      if (previous.fingerprint !== signature) throw Object.assign(Error('Identificador de envio já utilizado.'),{status:400})
      if (previous.result) return JSON.parse(previous.result)
      if (active.has(token)) return active.get(token)
      throw uncertain()
    }
    function uncertain() {
      return Object.assign(Error('Envio sem confirmação. Confira a conversa antes de repetir.'),{status:409,code:'unconfirmed'})
    }
    const result = Promise.resolve().then(send).then(message => {
      if (!message?.id) throw uncertain()
      // Keep only the receipt. The existing history owns text and attachments.
      complete.run(JSON.stringify({id:message.id,timestamp:message.timestamp,type:message.type,fromMe:true,ack:message.ack}),token)
      return message
    }).catch(() => { throw uncertain() }).finally(() => active.delete(token))
    active.set(token,result)
    return result
  }
}
module.exports = {createSendReceipts}
