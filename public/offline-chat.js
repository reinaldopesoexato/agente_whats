// Each workspace has its own origin. Account and chat are part of every message key.
const offlineChat = (() => {
  let connection
  function open() {
    if (!connection) connection = new Promise((resolve, reject) => {
      const request = indexedDB.open('whatsia-conversas', 1)
      request.onupgradeneeded = () => {
        const db = request.result
        db.createObjectStore('lists')
        const messages = db.createObjectStore('messages', {keyPath: ['account','chat','id']})
        messages.createIndex('timeline', ['account','chat','timestamp','id'])
        db.createObjectStore('queue', {keyPath:'order',autoIncrement:true})
        db.createObjectStore('payloads')
      }
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); connection = null }
        resolve(request.result)
      }
      request.onerror = () => reject(request.error)
    }).catch(e => { connection = null; throw e })
    return connection
  }
  async function transaction(stores, mode, work) {
    const db = await open()
    return new Promise((resolve,reject) => {
      const tx = db.transaction(stores, mode)
      const value = work(name => tx.objectStore(name))
      tx.oncomplete = () => resolve(value?.result)
      tx.onabort = tx.onerror = () => reject(tx.error || Error('Falha no armazenamento do aparelho.'))
    })
  }
  const lists = (key, value) => transaction(['lists'], value === undefined ? 'readonly' : 'readwrite',
    store => value === undefined ? store('lists').get(key) : store('lists').put(value,key))
  function remember(account,chat,messages) {
    return transaction(['messages'],'readwrite', store => {
      for (const msg of messages) store('messages').put({...msg, account, chat})
    })
  }
  async function page(account,chat,params) {
    const before = params.has('before') ? [account,chat,Number(params.get('before')),params.get('beforeId')] : [account,chat,[]]
    const range = IDBKeyRange.bound([account,chat],before,false,true)
    const db = await open()
    return new Promise((resolve,reject) => {
      const tx = db.transaction('messages')
      const request = tx.objectStore('messages').index('timeline').openCursor(range,'prev')
      const rows = []
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor && rows.length < 60) { rows.push(cursor.value); cursor.continue(); return }
        const first = rows.at(-1)
        resolve({messages:rows.reverse(),hasMore:!!cursor,next:first && {id:first.id,timestamp:first.timestamp},device:true})
      }
    })
  }
  function enqueue(account,chat,payload) {
    const id = crypto.randomUUID()
    return transaction(['queue','payloads'],'readwrite',store => {
      store('payloads').add(payload,id)
      return store('queue').add({id,account,chat,timestamp:Date.now(),body:payload.body,
        attachment:payload.voice ? 'Mensagem de voz' : payload.file?.name})
    })
  }
  const pending = () => transaction(['queue'],'readonly',store => store('queue').getAll())
  const payload = id => transaction(['payloads'],'readonly',store => store('payloads').get(id))
  const fail = (row,reason) => transaction(['queue'],'readwrite',store => store('queue').put({...row,reason}))
  function finish(row,message) {
    return transaction(['queue','payloads','messages'],'readwrite',store => {
      if (message) store('messages').put({...message,account:row.account,chat:row.chat})
      store('queue').delete(row.order)
      store('payloads').delete(row.id)
    })
  }
  async function clear() {
    await transaction(['queue','payloads','messages','lists'],'readwrite',store => {
      for (const name of ['queue','payloads','messages','lists']) store(name).clear()
    })
  }
  return {lists, remember, page, enqueue, pending, payload, fail, finish, clear}
})()
