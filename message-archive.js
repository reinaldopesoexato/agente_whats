const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')
const {messageSender,displayName} = require('./message-authors')
const { createHash, randomUUID } = require('node:crypto')

const digest = (account, id) => createHash('sha256').update(JSON.stringify([account, id])).digest('hex')
const serialized = id => typeof id === 'string' ? id : id?._serialized || id?.$1
const messageChat = message => message?.fromMe ? message.to : message?.from
const validChat = chat => typeof chat === 'string' && chat && !/@(?:broadcast|newsletter)$/.test(chat)

function archiveSpaceAvailable() {
  if(process.env.WHATSIA_TENANT!=='1') return true
  const usage=fsSync.statfsSync('/persist')
  const quota=Number(process.env.WHATSIA_QUOTA_GIB)*2**30
  return usage.bavail*usage.bsize>16*1024*1024 && (usage.blocks-usage.bfree)*usage.bsize<quota*0.9
}

function createMessageArchive(directory, policy = () => ({})) {
  const downloads = new Set()
  const queued = []
  let running = 0
  const files = (account, id) => {
    const hash = digest(account, id)
    const folder = path.join(directory, hash.slice(0, 2))
    return { folder, text: path.join(folder, hash + '.json'), media: path.join(folder, hash + '.bin'),
      marker: path.join(folder, hash + '.removed'), info: path.join(folder, hash + '.media.json'), status: path.join(folder, hash + '.status.json') }
  }
  const read = location => {
    try { return JSON.parse(fsSync.readFileSync(location, 'utf8')) }
    catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  const expired = (timestamp, days) => days > 0 && Date.now() - timestamp >= days * 86400000
  async function remove(location) {
    await fs.unlink(location).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
  async function scan({ prune = false, mediaOnly = false } = {}) {
    const entries = []
    const folders = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const folder of folders.filter(item => item.isDirectory() && /^[a-f0-9]{2}$/.test(item.name))) {
      const root = path.join(directory, folder.name)
      for (const name of await fs.readdir(root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue
        const record = await fs.readFile(path.join(root, name), 'utf8').then(JSON.parse).catch(() => null)
        if (!record) continue
        const options = policy(record.account, record.chat)
        const location = files(record.account, record.id)
        if (prune && !downloads.has(digest(record.account, record.id))) {
          const textExpired = expired(record.timestamp, options.textDays)
          if (textExpired && record.body) {
            const { body, ...metadata } = record
            await fs.writeFile(location.text + '.prune.tmp', JSON.stringify(metadata), { mode: 0o600 })
            await fs.rename(location.text + '.prune.tmp', location.text)
            delete record.body
          }
          if (textExpired && !record.media) {
            await remove(location.text)
            continue
          }
        }
        const size = await fs.stat(location.media).then(item => item.size).catch(() => 0)
        if (mediaOnly) {
          if (size && !downloads.has(digest(record.account,record.id))) {
            const mime=(read(location.info)?.mime || read(location.marker)?.mime || '').split('/')[0]
            entries.push({account:record.account,id:record.id,timestamp:record.timestamp,bytes:size,
              type:['image','audio','video'].includes(mime)?mime:'document'})
          }
          continue
        }
        entries.push({ id: record.id, account: record.account, chat: record.chat, timestamp: record.timestamp,
          bytes: size + (await fs.stat(location.text).then(item => item.size).catch(() => 0)) })
      }
    }
    return entries
  }
  const removed = (account,id)=>fsSync.existsSync(files(account,id).marker)
  const previews = new Map()
  async function preview({account='',type='all',days}) {
    if (typeof account !== 'string' || !['all','image','video','audio','document'].includes(type) ||
        !Number.isInteger(days) || days<1 || days>36500) throw Object.assign(Error('Confira os filtros de mídia.'),{status:400})
    const until=Date.now()-days*86400000
    const rows=(await scan({mediaOnly:true})).filter(r=>(!account||account===r.account) && (type==='all'||type===r.type) && r.timestamp<until)
    for(const [key,item] of previews) if(item.expires<Date.now()) previews.delete(key)
    if(previews.size>=8) previews.delete(previews.keys().next().value)
    const ticket=randomUUID()
    previews.set(ticket,{rows,expires:Date.now()+300000})
    return {ticket,count:rows.length,bytes:rows.reduce((sum,r)=>sum+r.bytes,0)}
  }
  async function clean(ticket) {
    const selection=previews.get(ticket)
    previews.delete(ticket)
    if(!selection || selection.expires<Date.now()) throw Object.assign(Error('Calcule o espaço novamente.'),{status:409})
    let bytes=0,count=0
    for(const row of selection.rows) {
      const loc=files(row.account,row.id)
      if(downloads.has(digest(row.account,row.id))) continue
      const stat=await fs.stat(loc.media).catch(e=>{if(e.code!=='ENOENT') throw e})
      if(!stat || stat.size!==row.bytes) continue
      // Rename an existing directory entry: a full user quota must still permit cleanup.
      try {await fs.rename(loc.info,loc.marker)}
      catch(e) {
        if(e.code!=='ENOENT') throw e
        if(!fsSync.existsSync(loc.marker)) await fs.writeFile(loc.marker,'{}',{mode:0o600})
      }
      try {await fs.unlink(loc.media);bytes+=row.bytes;count++}
      catch(e){if(e.code!=='ENOENT') throw e}
    }
    return {count,bytes}
  }
  function pump() {
    while (running < 4 && queued.length) {
      const job = queued.shift()
      running++
      job.run().then(() => { downloads.delete(job.hash) }).catch(async error => {
        const reason = error.code === 'ARCHIVE_LIMIT' ? 'A mídia excede o limite de 18 MiB.' :
          error.code === 'ARCHIVE_NO_MEDIA' ? 'A mídia ainda não está disponível no WhatsApp.' : 'Falha ao baixar ou gravar a mídia.'
        const retry = error.code !== 'ARCHIVE_LIMIT' && job.attempt < 3 && job.allowed()
        await fs.writeFile(job.location.status, JSON.stringify({ reason, attempts: job.attempt, retry }), { mode: 0o600 }).catch(() => {})
        if (retry) {
          const timer = setTimeout(() => {
            if (job.allowed()) { job.attempt++; queued.push(job); pump() }
            else downloads.delete(job.hash)
          }, job.attempt * 5000)
          timer.unref()
        } else downloads.delete(job.hash)
      }).finally(() => { running--; pump() })
    }
  }
  function capture(account, message, overrideId) {
    const id = overrideId || serialized(message?.id)
    const chat = messageChat(message)
    const timestamp = message?.timestamp * 1000
    if (!id || !validChat(chat) || !Number.isFinite(timestamp) || message.type === 'revoked') return null
    const options = policy(account, chat)
    if (options.enabled === false) return null
    const location = files(account, id)
    const current = read(location.text)
    if (!current) {
      fsSync.mkdirSync(location.folder, { recursive: true, mode: 0o700 })
      const record = { id, account, chat, timestamp, sender: messageSender(message), senderHint:displayName(message._data?.notifyName),
        fromMe: Boolean(message.fromMe), body: !expired(timestamp, options.textDays) && typeof message.body === 'string' ? message.body : '', media: Boolean(message.hasMedia) }
      fsSync.writeFileSync(location.text + '.tmp', JSON.stringify(record), { mode: 0o600 })
      fsSync.renameSync(location.text + '.tmp', location.text)
    }
    const hash = digest(account, id)
    const allowed = () => {
      const settings = policy(account, chat)
      return settings.enabled !== false && !removed(account,id) && archiveSpaceAvailable()
    }
    if (message.hasMedia && allowed() && typeof message.downloadMedia === 'function' && !downloads.has(hash) &&
        !fsSync.existsSync(location.info) && queued.length < 250) {
      downloads.add(hash)
      queued.push({ hash, location, allowed, attempt: 1, run: async () => {
        if (!allowed()) return
        const media = await message.downloadMedia()
        if (typeof media?.data !== 'string' || !media.data) throw Object.assign(new Error('Mídia indisponível.'), { code: 'ARCHIVE_NO_MEDIA' })
        if (media.data.length > 24 * 1024 * 1024) throw Object.assign(new Error('Limite de mídia.'), { code: 'ARCHIVE_LIMIT' })
        if (!allowed()) return
        const content = Buffer.from(media.data, 'base64')
        if (!content.length || content.length > 18 * 1024 * 1024) throw Object.assign(new Error('Limite de mídia.'), { code: 'ARCHIVE_LIMIT' })
        await fs.writeFile(location.media + '.tmp', content, { mode: 0o600 })
        await fs.rename(location.media + '.tmp', location.media)
        const name = path.basename(String(media.filename || 'anexo').replace(/\\/g, '/')).replace(/[\u0000-\u001f]/g, '').slice(0, 180)
        await fs.writeFile(location.info + '.tmp', JSON.stringify({ name: name || 'anexo', mime: media.mimetype }), { mode: 0o600 })
        await fs.rename(location.info + '.tmp', location.info)
        await remove(location.status)
      } })
      pump()
    }
    return id
  }

  function revoke(account, message, original, kind, fallback) {
    const aliases = [...new Set([
      serialized(message?.protocolMessageKey), serialized(original?.id), serialized(message?.id)
    ].filter(Boolean))]
    if (!aliases.length) return null
    let saved = aliases.map(id => read(files(account, id).text)).find(Boolean)
    if (original && original.type !== 'revoked') {
      const id = capture(account, original, saved?.id || aliases[0])
      if (id) saved = read(files(account, id).text)
    }
    if (!saved && kind === 'me' && message?.type !== 'revoked') {
      const id = capture(account, message, aliases[0])
      if (id) saved = read(files(account, id).text)
    }
    if (!saved) saved = aliases.map(fallback).find(Boolean)
    const chat = saved?.chat || messageChat(message)
    const timestamp = saved?.timestamp ?? message?.timestamp * 1000
    if (!validChat(chat) || !Number.isFinite(timestamp)) return null
    const target = message.protocolMessageKey
    const originalAuthor = original || (target ? {id:target,fromMe:target.fromMe} : message)
    return { id: saved?.id || aliases[0], aliases, account, chat, timestamp, sender: saved?.sender || messageSender(originalAuthor,chat),
      senderHint:saved?.senderHint || displayName(original?._data?.notifyName),
      fromMe: saved?.fromMe ?? original?.fromMe ?? target?.fromMe ?? Boolean(message.fromMe), kind }
  }

  function original(account, id, chat, timestamp) {
    const location = files(account, id)
    const saved = read(location.text)
    const options = policy(account, chat || saved?.chat)
    const date = timestamp || saved?.timestamp
    const record = saved && !expired(date, options.textDays) ? saved : null
    return { record, media: read(location.info),
      pending: downloads.has(digest(account, id)),issue: removed(account,id) ? 'Mídia removida para liberar espaço.' : read(location.status)?.reason }
  }

  return { capture, revoke, original, scan, preview, clean, removed, mediaPath: (account, id) => files(account, id).media }
}

module.exports = { createMessageArchive }
