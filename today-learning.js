// Keep only local, account-scoped examples of explicit category moves.
const stop = new Set(('a ao aos as com como da das de dele dela do dos e ela ele em entre era essa esse esta este eu foi ha isso ja la lhe mais mas me meu minha muito na nas no nos nossa nosso o obrigado obrigada oi ola os ou para pela pelo por pra pro que quem se seu sua sim sobre so te tem tenho ter tudo um uma vai voce voces bom boa dia tarde noite favor pode poderia segue seguinte preciso quero gostaria enviar enviado encaminho anexo arquivo mensagem hoje amanha ontem referente numero reais').split(' '))
const variants = new Map(Object.entries({
  pagamentos:'pagamento', pagar:'pagamento', pagos:'pago',
  reunioes:'reuniao', reuniao:'reuniao', agendar:'agenda', agendamento:'agenda',
  vencimentos:'vencimento', vence:'vencimento', vencer:'vencimento',
  manutencoes:'manutencao', manutencao:'manutencao', cotacoes:'cotacao'
}))
function keywords(...parts) {
  const words = new Set()
  for (const part of parts) {
    if (typeof part !== 'string') continue
    const text = part.slice(0, 5000).replace(/https?:\/\/\S+|[\w+/=-]{48,}/gi, ' ')
      .normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    for (const word of text.match(/[a-z]{3,}/g) || []) {
      if (stop.has(word) || word.length > 35) continue
      const token = variants.get(word) || word.replace(/([aeiou])s$/, '$1')
      words.add(token)
      if (words.size >= 60) return [...words]
    }
  }
  return [...words]
}
const sourceKey = (account, id) => JSON.stringify([account, id])
function sourceId(kind, item) {
  if (['message','unanswered','attachment'].includes(kind)) return item.id
  if (kind === 'approval') return item.delivery?.quoted
  return item.latest || item.source
}

function buildExamples(state, changes, at) {
  const lessons = new Map((state.todayLessons || []).map(example => [example.key, example]))
  if (!changes.length) return { lessons: [...lessons.values()], learned: 0 }
  const signatures = new Map()
  const signature = lesson => JSON.stringify([lesson.account,lesson.chat,[...lesson.tokens].sort()])
  for (const lesson of lessons.values()) signatures.set(signature(lesson),lesson.key)
  function forget(key) {
    const old = lessons.get(key)
    if (old) signatures.delete(signature(old))
    lessons.delete(key)
  }
  const messages = new Map()
  for (const message of state.messages) messages.set(sourceKey(message.account,message.id),message)
  const collections = { action:state.actions, decision:state.intelligence?.events, watch:state.intelligence?.watches,
    skill:state.skillRuns, approval:state.aiQueries }
  const indexes = new Map()
  let learned = 0
  for (const {key, destination} of changes) {
    let identity
    try { identity = JSON.parse(key) } catch { continue }
    if (!Array.isArray(identity) || identity.length !== 3) continue
    const [kind, account, id] = identity
    if (!account) continue
    let item
    if (['unanswered','attachment','message'].includes(kind)) item = messages.get(sourceKey(account,id))
    else {
      if (!indexes.has(kind)) indexes.set(kind,new Map((collections[kind] || []).map(row => [sourceKey(row.account,row.id),row])))
      item = indexes.get(kind).get(sourceKey(account,id))
    }
    if (!item) continue
    const msg = messages.get(sourceKey(account,sourceId(kind,item)))
    const exampleKey = msg ? sourceKey(account,msg.id) : key
    // Returning a failed attachment to its operational queue cancels that example.
    if (destination === 'attachments') { forget(exampleKey); continue }
    let tokens = msg ? messageKeywords(msg) : []
    if (!tokens.length) tokens = keywords(item.title,item.topic,item.detail,item.delivery?.body)
    if (!tokens.length || (tokens.length === 1 && tokens[0].length < 5)) { forget(exampleKey); continue }
    const lesson = {key:exampleKey,account,chat:msg?.chat || item.chat,kind:msg ? kind : 'message',destination,at,tokens}
    forget(exampleKey)
    const template = signature(lesson)
    forget(signatures.get(template))
    signatures.set(template,exampleKey)
    lessons.set(exampleKey,lesson)
    learned++
  }
  return { lessons:[...lessons.values()], learned }
}
function messageKeywords(record) {
  return keywords(record.body,record.transcript,record.extracted,record.caption)
}

function changesFromPlaces(places) {
  const moves = []
  for (const [key, placement] of Object.entries(places || {})) {
    if (typeof placement === 'string') moves.push({key,destination:placement})
    else if (placement?.added) {
      const entries = Object.entries(placement.added).sort((a,b)=>b[1]-a[1])
      if (entries.length && (entries.length===1 || entries[0][1]>entries[1][1])) moves.push({key,destination:entries[0][0]})
    }
  }
  return moves
}

const indexes = new WeakMap()
function lookup(lessons) {
  if (indexes.has(lessons)) return indexes.get(lessons)
  const byAccount = new Map()
  for (const lesson of lessons) {
    if (!byAccount.has(lesson.account)) byAccount.set(lesson.account,{index:new Map(),recent:[],byKey:new Map(),byDestination:new Map()})
    const {index,recent,byKey,byDestination} = byAccount.get(lesson.account)
    byDestination.set(lesson.destination,lesson)
    byKey.set(lesson.key,lesson)
    recent.push(lesson)
    if (recent.length > 16) recent.shift()
    for (const token of lesson.tokens) {
      if (!index.has(token)) index.set(token,[])
      index.get(token).push(lesson)
    }
  }
  indexes.set(lessons,byAccount)
  return byAccount
}
function matchLearning(state, record) {
  if (record.todayLearned || !record.liveReceivedAt || !state.todayLessons?.length) return
  const index = lookup(state.todayLessons).get(record.account)?.index
  if (!index) return
  const tokens = messageKeywords(record)
  const counts = new Map()
  const ownKey = sourceKey(record.account,record.id)
  for (const token of tokens) for (const lesson of index.get(token) || []) {
    if (lesson.at <= record.liveReceivedAt && lesson.key !== ownKey)
      counts.set(lesson,(counts.get(lesson) || 0)+1)
  }
  // Compare content first. A conversation can break a close tie, never create a match.
  const scores = new Map()
  for (const [lesson, common] of counts) {
    const exactShort = common === 1 && tokens.length === 1 && lesson.tokens.length === 1 && lesson.chat === record.chat
    if (common < 2 && !exactShort) continue
    const score = common / Math.sqrt(tokens.length * lesson.tokens.length)
    if (score < 0.58 || (common === 2 && score < 0.70)) continue
    const rank = score + (lesson.chat === record.chat ? 0.08 : 0)
    if (rank >= (scores.get(lesson.destination)?.rank || 0)) scores.set(lesson.destination,{rank,lesson})
  }
  const [best, second] = [...scores.values()].sort((a,b)=>b.rank-a.rank)
  if (best && (!second || best.rank-second.rank > 0.06)) {
    return best.lesson
  }
  return best ? false : undefined
}

function applyLearning(state, record) {
  const match = matchLearning(state,record)
  if (match) record.todayLearned = {destination:match.destination,kind:match.kind}
}

// Reuse the existing message analysis for paraphrases. Only topic words from this account enter the prompt.
function semanticExamples(state, record, {contextual = false} = {}) {
  if ((!contextual && record.todayLearned) || !record.liveReceivedAt || !state.todayLessons?.length) return []
  // A close conflict between two explicit corrections stays with the ordinary classifier.
  if (!contextual && matchLearning(state,record) !== undefined) return []
  const account = lookup(state.todayLessons).get(record.account)
  const tokens = messageKeywords(record)
  if (!account || (!contextual && !tokens.length)) return []
  const candidates = new Set([...account.recent,...account.byDestination.values()])
  for (const token of tokens) for (const example of account.index.get(token) || []) candidates.add(example)
  const eligible = [...candidates].filter(example=>example.at <= record.liveReceivedAt && example.key !== sourceKey(record.account,record.id))
  const words = new Set(tokens)
  const ranked = eligible.map(example=>({example,score:example.tokens.filter(word=>words.has(word)).length +
    (example.chat === record.chat ? 0.5 : 0)})).sort((a,b)=>b.score-a.score || b.example.at-a.example.at)
  const selected = []
  if (contextual) {
    for (const {example} of ranked) {
      if (!selected.some(other=>other.destination===example.destination)) selected.push(example)
      if (selected.length === 6) return selected
    }
  }
  for (const {example} of ranked) {
    if (selected.includes(example)) continue
    if (selected.filter(other=>other.destination===example.destination).length >= 2) continue
    selected.push(example)
    if (selected.length === 6) break
  }
  return selected
}

function applySemantic(state,record,examples,result) {
  if (record.todayLearned || result.todayExampleConfidence !== 'alta' ||
      !Number.isInteger(result.todayExample) || result.todayExample < 1) return
  const example = examples[result.todayExample-1]
  if (!example || lookup(state.todayLessons).get(record.account)?.byKey.get(example.key) !== example) return
  record.todayLearned = {destination:example.destination,kind:example.kind}
}

module.exports = {buildExamples,changesFromPlaces,applyLearning,semanticExamples,applySemantic,sourceId,sourceKey}
