const {reportEvidence,deliveryEvent} = require('./automatic-reports')
const { randomUUID } = require('node:crypto')
const { normalize } = require('./live-query')

const statuses = new Set(['proposto', 'confirmado', 'alterado', 'cancelado', 'concluido'])
const filler = new Set('para sobre voce como quem quando quais ficou combinado combinada prazo data responsavel instalacao? houve isso sobre aquele aquela cliente fornecedor responder resposta ficou foi uma que sim nao'.split(' '))
const terms = text => [...new Set(normalize(text).split(' ').filter(word => word.length >= 3 && !filler.has(word)))]
const clean = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const key = (account, chat, topic) => JSON.stringify([account, chat, normalize(topic)])

function intelligence(state) {
  return state.intelligence ??= { events: [], watches: [], corrections: [], aliases: [] }
}

function dateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const time = Date.parse(value + 'T00:00:00Z')
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : null
}

function watchDate(text, today) {
  if (!dateOnly(today)) return null
  const normalized = normalize(text)
  const date = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text)
  if (date) return dateOnly(date[3] + '-' + date[2] + '-' + date[1])
  if (dateOnly(text)) return text
  const weekdays = ['domingo','segunda','terca','quarta','quinta','sexta','sabado']
  const index = weekdays.indexOf(normalized.replace(/ feira$/, ''))
  const now = new Date(today + 'T00:00:00Z')
  let offset = normalized === 'hoje' ? 0 : normalized === 'amanha' ? 1 : null
  if (index !== -1) offset = (index - now.getUTCDay() + 7) % 7
  if (offset === null) return null
  now.setUTCDate(now.getUTCDate() + offset)
  return now.toISOString().slice(0, 10)
}

function watchRequest(prompt) {
  const match = /^(?:me avise|avise-me|me lembre)\s+se\s+(.+?)\s+n[aã]o\s+respond(?:er|eu)\s+(?:sobre\s+(.+?)\s+)?at[eé]\s+(.+?)[.!?]?$/i.exec(prompt)
  return match ? { target: match[1], topic: match[2] || '', due: match[3] } : null
}

function parseAlias(prompt) {
  const match = /^(?:aprenda|registre) que ["“]?(.+?)["”]? (?:[ée] o mesmo que|[ée] o apelido de) ["“]?(.+?)["”]?[.!?]?$/i.exec(prompt)
  if (!match) return null
  const alias = clean(match[1], 100), name = clean(match[2], 100)
  return alias && name && normalize(alias) !== normalize(name) ? { alias, name } : null
}

function expandedQuery(data, account, prompt) {
  const text = ' ' + normalize(prompt) + ' '
  return data.aliases.filter(item => item.account === account && text.includes(' ' + normalize(item.alias) + ' '))
    .slice(0, 5).map(item => item.name).join(' ')
}

function captureEvents(data, records, input) {
  if (!Array.isArray(input)) return 0
  const originals = new Map(records.map(record => [record.id, record]))
  let count = 0
  for (const item of input.slice(0, 8)) {
    const record = originals.get(item?.source)
    const topic = clean(item?.topic, 100)
    const quote = clean(item?.quote, 280)
    const detail = clean(item?.detail, 260)
    const status = normalize(item?.status)
    const original = normalize([record?.body, record?.transcript, record?.extracted].filter(Boolean).join(' '))
    if (!record || !topic || !detail || !quote || normalize(quote).length < 8 ||
        !original.includes(normalize(quote)) || !statuses.has(status)) continue
    if (reportEvidence(record) && deliveryEvent(item)) continue
    const eventKey = key(record.account, record.chat, topic)
    if (data.events.some(event => event.key === eventKey && event.source === record.id && event.status === status)) continue
    data.events.push({ id: randomUUID(), key: eventKey, account: record.account, chat: record.chat, source: record.id,
      timestamp: record.timestamp, topic, status, detail, quote, due: dateOnly(item.due), owner: clean(item.owner, 100) })
    count++
  }
  return count
}

function latestEvents(data, predicate = () => true) {
  const order = (a, b) => b.timestamp - a.timestamp || Number(Boolean(b.corrected)) - Number(Boolean(a.corrected))
  const ordered = data.events.filter(predicate).sort(order)
  const topics = new Map()
  for (const event of ordered) {
    const current = topics.get(event.key)
    if (!current) topics.set(event.key, event)
    else if (!current.corrected && current.status === 'proposto' && event.status !== 'proposto') topics.set(event.key, event)
  }
  return [...topics.values()].sort(order)
}

function relevantTopics(data, predicate, text) {
  const words = terms(text)
  return latestEvents(data, predicate).map(event => {
    const topical = terms(event.topic)
    return { event, score: words.filter(word => topical.includes(word)).length }
  }).filter(item => item.score).sort((a, b) => b.score - a.score || b.event.timestamp - a.event.timestamp)
}

function needsClarification(prompt, previous, candidates, scoped) {
  if (scoped || !/\b(?:aprovou|confirmou|aceitou|cancelou|respondeu|qual (?:o|a) (?:prazo|data|situacao))\b/.test(normalize(prompt))) return []
  const context = terms([prompt, previous].filter(Boolean).join(' '))
  const named = candidates.filter(item => terms(item.topic).some(word => context.includes(word)))
  const pool = named.length ? named : candidates
  const topics = [...new Map(pool.map(item => [normalize(item.topic), item.topic])).values()]
  return topics.length >= 2 ? topics.slice(0, 4) : []
}

function watchOutcome(watch, records, today) {
  const topic = terms(watch.topic)
  const matching = records.filter(record => record.account === watch.account && record.chat === watch.chat &&
    !record.fromMe && record.timestamp > watch.createdAt && (!watch.sender || record.sender === watch.sender))
    .sort((a, b) => a.timestamp - b.timestamp)
  for (const record of matching) {
    const text = normalize([record.body, record.transcript].filter(Boolean).join(' '))
    const matches = topic.filter(word => terms(text).includes(word)).length
    const substantive = /\b(?:confirm|aprov|neg|envi|entreg|respost|precis|consig|receb|pod|ficou|segue|cancel|pront)\w*/.test(text)
    if (topic.length && matches >= Math.min(topic.length, 2) && substantive) {
      return { status: 'respondido', source: record.id, answeredAt: record.timestamp }
    }
  }
  return { status: today > watch.due ? 'atrasado' : today === watch.due ? 'vence-hoje' : 'aguardando' }
}

function impact(action, today) {
  if (action.due && action.due < today) return { score: 100, reason: 'Prazo passou e o item segue aberto.' }
  if (action.due === today) return { score: 80, reason: 'Prazo vence hoje.' }
  if (action.possiblyResolved) return { score: 60, reason: 'Há uma mensagem que pode confirmar a resolução.' }
  if (action.followUp) return { score: 40, reason: 'Acompanhamento agendado por você.' }
  return { score: 20, reason: 'Ação ainda aberta.' }
}

const eventInstructions = ' Retorne também events, uma lista de decisões ou compromissos explícitos, com source (ID da mensagem original), topic (nome estável e específico, reaproveite um tópico anterior quando for a mesma decisão), status (proposto, confirmado, alterado, cancelado ou concluido), detail, owner, due (YYYY-MM-DD quando explícita), e quote (trecho literal e curto da mensagem original). Um comprovante automático de geração ou envio de relatório por um equipamento não é uma decisão ou compromisso. Não transforme hipótese em decisão. Se não houver evento, retorne events vazio.'

module.exports = { intelligence, dateOnly, watchDate, watchRequest, parseAlias, expandedQuery, captureEvents, latestEvents,
  relevantTopics, needsClarification, watchOutcome, impact, eventInstructions, terms }
