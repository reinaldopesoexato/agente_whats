const { randomUUID } = require('node:crypto')

// One short replay buffer per server and one board comparison for all subscribers.
function createNotificationFeed(visitCards,push) {
  const clients = new Set()
  const epoch = randomUUID()
  const history = []
  let sequence = 0
  let known = null
  let scanTimer, idleTimer

  function deliver(client, entry) {
    if (entry.notice.kind === 'message' ? !client.messages : !client.cards) return
    if (!client.res.write('id: ' + entry.id + '\ndata: ' + JSON.stringify(entry.notice) + '\n\n')) client.res.destroy()
  }
  function publish(notice) {
    sequence++
    const entry = {id:epoch + '/' + sequence, number:sequence, notice, at:Date.now()}
    history.push(entry)
    while (history.length > 512 || history[0].at < entry.at - 120000) history.shift()
    push?.publish(entry.id,notice).catch(()=>console.warn('Envio de push temporariamente indisponível.'))
    for (const client of clients) deliver(client,entry)
  }
  // Remember cards that temporarily leave the board (e.g. unanswered or snoozed).
  const removed = new Set()
  function scan() {
    const next = new Set()
    const emitted = new Set()
    visitCards((key, visible, makeNotice) => {
      next.add(key)
      if (known && visible && !known.has(key) && !removed.has(key) && !emitted.has(key)) {
        emitted.add(key)
        publish(makeNotice())
      }
    })
    for (const key of known || []) if (!next.has(key)) removed.add(key)
    for (const key of next) removed.delete(key)
    while (removed.size > 4096) removed.delete(removed.values().next().value)
    known = next
  }
  function changed() {
    if (!known || scanTimer) return
    scanTimer = setTimeout(() => {
      scanTimer = undefined
      try { scan() } catch (error) { console.error('Falha ao atualizar notificações de Hoje:', error.message) }
    },450)
    scanTimer.unref()
  }
  function subscribe(req,res) {
    const client = {res, messages:req.query.messages === '1', cards:req.query.cards === '1'}
    if (!client.cards && !client.messages) return res.sendStatus(400)
    if (client.cards) {
      clearTimeout(idleTimer)
      // Flush pending changes before a newly enabled browser joins.
      scan()
    }
    res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'})
    res.flushHeaders()
    res.write(': conectado\n\n')
    const cursor = req.get('Last-Event-ID') || req.query.after
    if (typeof cursor === 'string' && cursor.startsWith(epoch + '/')) {
      const last = Number(cursor.slice(epoch.length+1))
      if (Number.isSafeInteger(last) && last >= 0) {
        for (const entry of history) if (entry.number > last && Date.now()-entry.at <= 120000) deliver(client,entry)
      }
    }
    res.write('event: ready\nid: ' + epoch + '/' + sequence + '\ndata: {}\n\n')
    clients.add(client)
    const heartbeat = setInterval(()=>res.write(': ativo\n\n'),25000)
    heartbeat.unref()
    res.on('close',()=>{
      clearInterval(heartbeat)
      clients.delete(client)
      if (client.cards && !push?.hasCards() && ![...clients].some(item=>item.cards)) {
        idleTimer = setTimeout(()=>{
          if (push?.hasCards() || [...clients].some(item=>item.cards)) return
          clearTimeout(scanTimer)
          scanTimer = undefined
          known = null
          removed.clear()
        },15000)
        idleTimer.unref()
      }
    })
  }
  function refreshDevices() {
    if (push?.hasCards()) {
      clearTimeout(idleTimer)
      if (!known) scan()
    } else if (![...clients].some(c=>c.cards)) {
      clearTimeout(scanTimer)
      scanTimer=undefined
      known=null
      removed.clear()
    }
  }
  return {publish, changed, subscribe, refreshDevices, close() {
    for (const {res} of clients) res.end()
    clearTimeout(scanTimer)
    clearTimeout(idleTimer)
  }}
}

module.exports = {createNotificationFeed}
