const fs = require('node:fs/promises')
const path = require('node:path')
const {createHash,randomUUID} = require('node:crypto')

const day = 86400000
const maxBytes = 2 * 1024 * 1024
function imageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg'
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP') return 'image/webp'
  return null
}

async function downloadPhoto(address, request = fetch) {
  if (!address) return Buffer.alloc(0)
  const url = new URL(address)
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !/(^|\.)whatsapp\.(net|com)$/.test(url.hostname)) throw Error('Endereço de foto inválido.')
  const response = await request(url, {redirect:'error',signal:AbortSignal.timeout(7000)})
  if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
    await response.body?.cancel()
    throw Error('Foto indisponível.')
  }
  const chunks = []
  let size = 0
  for await (const chunk of response.body) {
    size += chunk.length
    if (size > maxBytes) throw Error('Foto muito grande.')
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (!imageType(bytes)) throw Error('Formato de foto inválido.')
  return bytes
}

// The file contains the actual picture or About text. An empty file records a successful lookup without a value.
function createProfileCache(directory, now = Date.now) {
  const running = new Map()
  const retryAt = new Map()
  const lanes = Array.from({length:4},()=>Promise.resolve())
  let lane = 0
  async function read(file) {
    let handle
    try {
      handle = await fs.open(file,'r')
      const updated = (await handle.stat()).mtimeMs
      return {bytes:await handle.readFile(),updated}
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return null
    } finally { await handle?.close() }
  }
  return async function get(account, peer, field, fetchValue) {
    const hash = createHash('sha256').update(JSON.stringify([account,peer,field])).digest('hex')
    const file = path.join(directory,hash)
    const saved = await read(file)
    if (!fetchValue || (saved && now()-saved.updated < (saved.bytes.length ? day : 900000)) ||
        (retryAt.get(hash) || 0) > now()) return saved?.bytes ?? null
    let task = running.get(hash)
    if (!task) {
      if (running.size >= 64) return saved?.bytes ?? null
      const index = lane++ % lanes.length
      task = lanes[index].then(async()=>{
        const bytes = await fetchValue()
        await fs.mkdir(directory,{recursive:true,mode:0o700})
        const temp = file + '.' + randomUUID()
        try {
          await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600})
          await fs.rename(temp,file)
        } finally { await fs.rm(temp,{force:true}) }
        retryAt.delete(hash)
        return bytes
      }).catch(()=>{
        if (retryAt.size >= 4096) retryAt.delete(retryAt.keys().next().value)
        retryAt.set(hash,now()+60000)
        return saved?.bytes ?? null
      }).finally(()=>running.delete(hash))
      lanes[index] = task.then(()=>{})
      running.set(hash,task)
    }
    return saved?.bytes ?? task
  }
}

module.exports = {imageType,downloadPhoto,createProfileCache}
