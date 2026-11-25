const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim()

function directoryCommand(prompt) {
  const text = normalize(prompt).replace(/^(?:por favor |voce pode |pode |quero (?:ver|saber) )/, '')
  const membership = /^(?:em )?(?:quais|que) grupos (?:a |o )?(.+?) (?:aparece|esta|participa|faz parte)$/.exec(text)
  if (membership) return { kind: 'participacao', name: membership[1] }
  const activity = /^(?:(?:liste|quais|mostre|quero ver) )?(?:os )?grupos(?: (?:de|do|da) (.+?))? (?:ativos|que (?:tiveram atividade|conversaram)) (hoje|ontem|(?:esta|nesta|na ultima) semana|(?:nos )?ultimos \d+ dias)$/.exec(text)
  if (activity) return { kind: 'atividade', topic: activity[1], period: activity[2] }
  const request = /^(?:(?:liste|listar|mostre|mostrar|exiba|ver|quais sao|quais|quantos|quantas)\s+)?(?:(?:todos|todas|os|as|meus|minhas)\s+)*(grupos|contatos)(?:\s+(?:eu tenho|tenho|do whatsapp|no whatsapp))?(?:\s+(?:de|das|nas)\s+(?:todas|ambas)\s+(?:as\s+)?contas)?$/.exec(text)
  if (!request) return null
  return { kind: request[1], countOnly: /^quantos\b|^quantas\b/.test(text),
    allAccounts: /\b(?:todas|ambas) (?:as )?contas$/.test(text) }
}

const ignored = new Set('diga fale liste mostre sobre nosso meus minhas quero saber chats grupo grupos conversa conversas contato contatos pessoa mensagem mensagens whatsapp historico aconteceu falou disseram ultimamente ultimas ultimos recapitulacao resumo recente recentes'.split(' '))
const words = value => new Set(normalize(value).split(' ').filter(word => word.length >= 3 && !ignored.has(word)))

function lookupPlan({ prompt, related, evidence, candidates, chat, person }) {
  const text = normalize(prompt)
  const freshness = /\b(?:hoje|ontem|agora|esta semana|desde|ultim[oa]s?|recentes?|atualizad[oa]s?|novidades|busque|procure|consulte|verifique|confira)\b/.test(text)
  const keywords = words(prompt)
  for (const word of words(related)) keywords.add(word)
  const sources = new Map()
  for (const item of evidence) {
    if (item.chat && item.source) {
      const key = JSON.stringify([item.account, item.chat])
      sources.set(key, (sources.get(key) || 0) + 1)
    }
  }
  const originalCount = evidence.filter(item => item.type === 'mensagem' && item.source).length
  const topicSearch = /\b(?:grupo|contato|conversa|mensagen[sm]|whatsapp|chat)\b/.test(text)
  const scored = candidates.map(item => {
    const name = normalize(item.name)
    const nameWords = [...words(name)]
    const named = name.length >= 3 && (' ' + text + ' ').includes(' ' + name + ' ')
    const overlap = nameWords.filter(word => keywords.has(word)).length
    const relatedCount = sources.get(JSON.stringify([item.account, item.id])) || 0
    return { ...item, relevance: (named ? 20 : 0) + overlap * 3 + Math.min(5, relatedCount) + (chat || person ? 10 : 0),
      named: named || overlap >= 2 }
  }).sort((a, b) => b.relevance - a.relevance || b.timestamp - a.timestamp)
  if (!freshness && originalCount >= 4 && !scored.some(item => item.named && item.relevance >= 20 && originalCount < 8)) return []
  if (!chat && !person && !topicSearch && !freshness && !scored.some(item => item.relevance >= 3)) return []
  const relevant = scored.filter(item => item.relevance > 0)
  if (relevant.length) return relevant.slice(0, 5)
  return (topicSearch || freshness) && !person ? scored.slice(0, 2) : []
}

function queryPeriod(prompt, today) {
  const time = Date.parse(today + 'T00:00:00Z')
  if (!Number.isFinite(time)) return {}
  const date = offset => new Date(time + offset * 86400000).toISOString().slice(0, 10)
  const text = normalize(prompt)
  const relative = /\bultim[oa]s? (\d{1,3}) dias\b/.exec(text)
  if (relative && Number(relative[1]) >= 1) return { since: date(1 - Number(relative[1])), until: today }
  const explicit = /\bdesde\s+(\d{2})\/(\d{2})\/(\d{4})\b/i.exec(prompt)
  if (explicit) {
    const since = explicit[3] + '-' + explicit[2] + '-' + explicit[1]
    if (Number.isFinite(Date.parse(since)) && new Date(since).toISOString().slice(0, 10) === since && since <= today) return { since, until: today }
  }
  const weekdays = ['domingo', 'segunda', 'terca', 'quarta', 'quinta', 'sexta', 'sabado']
  const day = weekdays.indexOf(/\bdesde (domingo|segunda|terca|quarta|quinta|sexta|sabado)\b/.exec(text)?.[1])
  if (day >= 0) return { since: date(-((new Date(time).getUTCDay() - day + 7) % 7)), until: today }
  if (/\b(?:esta|nesta|desta|nessa|essa) semana\b/.test(text)) {
    return { since: date(-((new Date(time).getUTCDay() + 6) % 7)), until: today }
  }
  if (/\bultima semana\b/.test(text)) return { since: date(-6), until: today }
  if (/\bontem\b/.test(text)) return { since: date(-1), until: /\bdesde ontem\b/.test(text) ? today : date(-1) }
  if (/\bhoje\b/.test(text)) return { since: today, until: today }
  return {}
}

module.exports = { directoryCommand, lookupPlan, normalize, queryPeriod }
