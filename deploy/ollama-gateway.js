'use strict'
const http = require('node:http')

const base = 'http://whatsia-ollama-engine:11434'
const limit = 26 * 1024 * 1024
let pending = 0

// This service is reachable from private workspace networks. It holds no user state.
async function readChat(req) {
  const parts = []
  let size = 0
  for await (const part of req) {
    size += part.length
    if (size > limit) throw new Error('size')
    parts.push(part)
  }
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 100 ||
      typeof body.model !== 'string' || !/^[\w.-]+(?:\/[\w.-]+)?(?::[\w.-]+)?$/.test(body.model)) throw new Error('request')
  const messages = body.messages.map(({role, content, images}) => {
    if (!['system','user','assistant'].includes(role) || typeof content !== 'string') throw new Error('message')
    if (images !== undefined && (!Array.isArray(images) || images.length > 8 ||
        images.some(image => typeof image !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(image)))) throw new Error('image')
    return images ? {role, content, images} : {role, content}
  })
  const amount = body.options?.num_predict
  return {model: body.model, messages, format: 'json', stream: false, think: false,
    options: {num_predict: Number.isInteger(amount) ? Math.min(8192, Math.max(1, amount)) : 2500}}
}

async function serve(req,res) {
  const listing = req.method === 'GET' && req.url === '/api/tags'
  if (!listing && !(req.method === 'POST' && req.url === '/api/chat')) {res.writeHead(404).end(); return}
  if (pending >= 8) {res.writeHead(429).end(); return}
  pending++
  try {
    let input
    if (!listing) {
      try {input = await readChat(req)} catch (error) {res.writeHead(error.message === 'size' ? 413 : 400).end(); return}
    }
    const signal = AbortSignal.timeout(180000)
    const catalog = await fetch(base + '/api/tags', {signal})
    if (!catalog.ok) throw new Error('catalog')
    const {models} = await catalog.json()
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    if (listing) {res.end(JSON.stringify({models})); return}
    if (!models.some(m => m.name === input.model || m.name === input.model + ':latest')) {
      res.writeHead(404).end(JSON.stringify({error:'model not found'})); return
    }
    const answer = await fetch(base + '/api/chat', {method:'POST', signal,
      headers:{'Content-Type':'application/json'}, body:JSON.stringify(input)})
    res.writeHead(answer.status).end(await answer.text())
  } catch {if (!res.headersSent) res.writeHead(503); res.end()}
  finally {pending--}
}
http.createServer(serve).listen(11434,'0.0.0.0')
