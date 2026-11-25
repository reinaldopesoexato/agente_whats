const { randomUUID } = require('node:crypto')

const { sourceKey, sourceId } = require('./today-learning')

const defaults = [
  ['today-pending', 'Pendências por impacto'],
  ['today-unanswered', 'Mensagens sem resposta'],
  ['today-followups', 'Acompanhamentos'],
  ['today-approvals', 'Aprovações'],
  ['today-decisions', 'Decisões e compromissos']
]

const isStandard = id => defaults.some(([key]) => key === id)

function categories(state) {
  return state.todayCategories ??= defaults.map(([id, name]) => ({
    id, name, prompt: '', hidden: false, showNotifications:true, days: 0, revision: 0, since: 0
  }))
}

function categoryError(status, message) {
  return Object.assign(new Error(message), { status })
}

function saveCategory(state, id, fields = {}) {
  const list = categories(state)
  const current = id && list.find(item => item.id === id)
  if (id && !current) throw categoryError(404, 'Categoria não encontrada.')
  if (current && current.revision !== fields.revision) throw categoryError(409, 'A categoria foi alterada. Reabra a edição para usar a versão atual.')
  const name = typeof fields.name === 'string' && fields.name.trim()
  const prompt = typeof fields.prompt === 'string' && fields.prompt.trim()
  if (!name || name.length > 80 || typeof prompt !== 'string' || prompt.length > 1000 ||
      typeof fields.hidden !== 'boolean' || (fields.showNotifications !== undefined && typeof fields.showNotifications !== 'boolean') || ![0, 1, 7, 30, 90].includes(fields.days)) {
    throw categoryError(400, 'Confira o nome, o período e o prompt da categoria.')
  }
  const category = current || { id: randomUUID(), revision: 0 }
  if (!current || current.prompt !== prompt) category.since = Date.now()
  Object.assign(category, { name, prompt, showNotifications:fields.showNotifications ?? current?.showNotifications ?? true, hidden: fields.hidden, days: fields.days, revision: category.revision + 1 })
  if (!current) list.push(category)
  return category
}

function moveCategory(state, id, target, after) {
  const list = categories(state)
  const from = list.findIndex(item => item.id === id)
  if (from < 0 || !list.some(item => item.id === target)) throw categoryError(404, 'Categoria não encontrada.')
  if (target === id) return
  const [item] = list.splice(from, 1)
  list.splice(list.findIndex(other => other.id === target) + Number(after), 0, item)
}

function classificationRules(state, record) {
  return categories(state).filter(item => item.prompt && record.liveReceivedAt >= (item.since || 0))
    .map(({ id, name, prompt }) => ({ id, name, prompt }))
}

function categoryMatches(result, rules) {
  const ids = new Set(Array.isArray(result.todayCategoryIds) ? result.todayCategoryIds : [])
  return rules.filter(rule => ids.has(rule.id)).map(rule => rule.id)
}

function cardKey(kind, item) {
  return JSON.stringify([kind, item.account || '', item.id])
}

// Keep a prior version of a topic visible until the new decision has a destination.
function publishedDecisionEvents(state, account) {
  const waiting = new Set()
  for (const message of state.messages) {
    const review = message.todayReview
    if (review?.status !== 'pending' || !review.newDecisionIds?.length ||
        (account !== undefined && message.account !== account)) continue
    for (const id of review.newDecisionIds) waiting.add(sourceKey(message.account,id))
  }
  return state.intelligence.events.filter(event => (account === undefined || event.account === account) &&
    (!waiting.size || !waiting.has(sourceKey(event.account,event.id)) ||
      state.todayCardPlaces?.[cardKey('decision',event)] !== undefined))
}

function supplementKey(kind,item,key) {
  // A decision keeps its topic when the next message creates a new version.
  return kind === 'decision' && item.key ? JSON.stringify(['decision-topic',item.account,item.chat,item.key]) : key
}

function cardRoutes(state, account, chat) {
  const routes = new Map()
  const custom = new Set(categories(state).filter(c=>!isStandard(c.id)).map(c=>c.id))
  for (const message of state.messages) {
    if ((account !== undefined && message.account !== account) || (chat !== undefined && message.chat !== chat)) continue
    const change = message.todaySupplement
    const ids = message.todayCategoryIds
    const decisionCategory = ids?.length === 1 && custom.has(ids[0]) ? ids[0] : undefined
    if (message.todayLearned || change?.category || decisionCategory) {
      routes.set(sourceKey(message.account,message.id),{...message.todayLearned,supplement:change,decisionCategory})
    }
  }
  return routes
}

function nativeCards(state, kind, records, origin, limit, routes, represented, select) {
  const result = []
  let inOrigin = 0
  for (const item of records) {
    const key = cardKey(kind, item)
    const original = typeof origin === 'function' ? origin(item) : origin
    const placed = state.todayCardPlaces?.[key]
    const source = routes?.size ? sourceKey(item.account, sourceId(kind,item)) : undefined
    const learned = routes?.get(source)
    const change = learned?.supplement
    const inherited = change?.category && change.key === supplementKey(kind,item,key) ? change : undefined
    const promptDestination = kind === 'decision' && !learned?.kind && !inherited ? learned?.decisionCategory : undefined
    const linked = learned?.kind === kind || Boolean(promptDestination)
    const originalSource = inherited && sourceKey(item.account,inherited.root)
    const linkedRoot = originalSource && routes?.get(originalSource)?.kind === kind
    const messageKey = (linked || linkedRoot) && cardKey('message',{account:item.account,id:linked ? sourceId(kind,item) : inherited.root})
    const placement = messageKey && state.todayCardPlaces?.[messageKey]
    let automatic = linked ? (promptDestination || learned.destination) : inherited?.category
    if (placement?.removed?.includes(automatic)) automatic = Object.keys(placement.added || {}).at(-1) || null
    const category = placed === undefined ? (automatic === undefined ? original : automatic) : placed
    if (messageKey && category !== null) represented?.set(key,{source,originalSource:linkedRoot && originalSource,messageKey,category})
    if (category === null) continue
    const selected = select?.(item, category, key)
    if (selected === false || (selected === undefined && placed === undefined && !automatic && ++inOrigin > limit)) continue
    result.push({ ...item, card: { key, category } })
  }
  return result
}

// Build the entire mutation before replacing the saved map, including moves between overlapping lists.
function batchPlaces(state, request, visible) {
  const { action, items, destination } = request || {}
  if (!['move', 'delete'].includes(action) || !Array.isArray(items) || !items.length) throw categoryError(400, 'Marque os cartões para continuar.')
  const attachmentReturn = destination === 'attachments' && items.every(card => typeof card?.key === 'string' && card.key.startsWith('["attachment",'))
  if (action === 'move' && !attachmentReturn && !categories(state).some(item => item.id === destination)) {
    throw categoryError(400, 'Escolha uma categoria de destino.')
  }
  const previous = state.todayCardPlaces || {}
  const next = { ...previous }
  const unique = new Map()
  for (const card of items) {
    if (!card || typeof card.key !== 'string' || typeof card.category !== 'string') throw categoryError(400, 'Cartão inválido.')
    unique.set(JSON.stringify([card.key, card.category]), card)
  }
  for (const { key, category } of unique.values()) {
    const locations = visible.get(key)
    const prior = previous[key]
    const classified = key.startsWith('["message",')
    if (!locations?.has(category)) {
      const alreadyApplied = classified ? prior?.removed?.includes(category) &&
        (action === 'delete' || locations?.has(destination)) :
        action === 'delete' ? prior === null : prior === destination
      if (alreadyApplied) continue
      throw categoryError(409, 'Um cartão saiu da seleção ou mudou de categoria. Atualize a seleção e tente novamente.')
    }
    if (action === 'move' && category === destination) continue
    if (!classified) {
      next[key] = action === 'delete' ? null : destination
      continue
    }
    const placement = next[key] || {}
    const removed = new Set(placement.removed)
    const added = { ...placement.added }
    removed.add(category)
    delete added[category]
    if (action === 'move') {
      removed.delete(destination)
      added[destination] = Date.now()
    }
    next[key] = { removed: [...removed], added }
  }
  return next
}

function groupedMessages(state, today, dayOf, account, sorted = true, chat) {
  const lists = new Map(categories(state).map(item => {
    const start = new Date(today + 'T00:00:00Z')
    start.setUTCDate(start.getUTCDate() - item.days + 1)
    return [item.id, { since: item.days ? start.toISOString().slice(0, 10) : '', messages: [] }]
  }))
  const revoked = new Set(state.revokedMessages.flatMap(item => [item.id, ...(item.aliases || [])].map(id => JSON.stringify([item.account, id]))))
  for (const message of state.messages) {
    if ((account !== undefined && message.account !== account) || (chat !== undefined && message.chat !== chat)) continue
    const placement = state.todayCardPlaces?.[cardKey('message', message)]
    if ((!message.todayCategoryIds?.length && !message.todayLearned && !placement) || revoked.has(JSON.stringify([message.account, message.id]))) continue
    const ids = new Set(message.todayLearned ? [message.todayLearned.destination] : message.todayCategoryIds || [])
    for (const id of placement?.removed || []) ids.delete(id)
    for (const id of Object.keys(placement?.added || {})) ids.add(id)
    for (const id of ids) {
      const group = lists.get(id)
      if (group && (!group.since || dayOf(Math.max(message.timestamp, placement?.added?.[id] || 0)) >= group.since)) group.messages.push(message)
    }
  }
  if (sorted) {
    for (const group of lists.values()) group.messages.sort((a,b) => b.timestamp-a.timestamp || a.id.localeCompare(b.id))
  }
  return lists
}

module.exports = { cardRoutes, supplementKey, categories, saveCategory, moveCategory, classificationRules, categoryMatches, groupedMessages, cardKey, publishedDecisionEvents, nativeCards, batchPlaces }
