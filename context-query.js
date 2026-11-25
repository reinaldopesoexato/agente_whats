const { mediaExcerpt } = require('./pdf-text')
const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const stop = new Set('qual quais quem que onde quando porque como para pelo pela por isso isto essa esse esta este deve devo meu meus minha minhas sua suas seus tem teve mais tanto hoje semana ainda todo tudo sobre relacionado relacionados quero saber'.split(' '))
const words = value => [...new Set(normalize(value).match(/[a-z0-9]{3,}/g) || [])].filter(word => !stop.has(word))

const rememberPrefix = /^(?:por favor,?\s+)?(?:lembre(?:-se)?|memorize|guarde na mem[oó]ria)\b\s*(?::\s*|(?:que|de)\s+)?/i
const contextualNote = /^(?:ela|ele|isso|isto|aquilo|esse|essa)\b/i
const personName = /^[\p{L}\p{M}][\p{L}\p{M}'’ -]{0,99}$/u

function ageQuestion(question) {
  const text = String(question || '').trim().replace(/[?!.]+$/, '').trim()
  const match = text.match(/^(?:(?:qual (?:é|e) )?a )?idade (?:d[aeo]) (.+)$/i) ||
    text.match(/^quantos anos (?:(?:a|o) )?(.+) tem$/i)
  const name = match?.[1]?.trim()
  return name && personName.test(name) && !/\b(?:e|ou|anos)\b/i.test(name) && !/^(?:ela|ele)$/i.test(name) ? name : null
}

function* rememberedPrompts(state, { account, chat, person, allAccounts, now, ownerThread }) {
  const preceding = new Map()
  for (const item of state.aiQueries) {
    const privateTurn = item.ownerChannel && item.thread === ownerThread
    if (item.timestamp >= now || (item.ownerChannel && !privateTurn) ||
        (!privateTurn && item.account !== account.id && !(allAccounts && account.mode === 'local'))) continue
    const scope = privateTurn ? ownerThread : JSON.stringify([item.thread || null, item.account, item.chat || null,
      item.person || null, Boolean(item.allAccounts)])
    if (item.remember && (!chat || chat === item.chat) && (!person || person.id === item.person)) {
      const note = item.prompt.replace(rememberPrefix, '').trim()
      const topic = contextualNote.test(note) ? preceding.get(scope) : null
      yield { item, note, topic }
    }
    if (!rememberPrefix.test(item.prompt) && !item.delivery) preceding.set(scope, item.prompt)
  }
}

function birthMemory(memory) {
  const match = memory.note.match(/^(.+?) nasceu em (\d{2})\/(\d{2})\/(\d{4})[.!]?$/i)
  if (!match) return null
  const [, subject, day, month, year] = match
  const name = /^(?:ela|ele)$/i.test(subject) ? ageQuestion(memory.topic) : subject.replace(/^(?:a|o) /i, '')
  if (!name || !personName.test(name)) return null
  const date = [year, month, day].join('-')
  const parsed = new Date(date + 'T00:00:00Z')
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  return { name, date, formatted: [day, month, year].join('/') }
}

function answerAgeFromMemory(state, options) {
  const name = ageQuestion(options.question)
  if (!name) return null
  const dates = new Map()
  for (const memory of rememberedPrompts(state, options)) {
    const birth = birthMemory(memory)
    if (birth && normalize(birth.name) === normalize(name) && birth.date <= options.today) {
      dates.set(birth.date, birth)
    }
  }
  if (!dates.size) return null
  if (dates.size > 1) {
    const conflicting = [...dates.values()].map(birth => birth.formatted).join(', ')
    return { answer: 'Encontrei datas de nascimento diferentes na memória (' + conflicting +
      '). Qual é a data correta?', contexts: dates.size, sources: [] }
  }
  const birth = dates.values().next().value
  const age = Number(options.today.slice(0, 4)) - Number(birth.date.slice(0, 4)) -
    Number(options.today.slice(5) < birth.date.slice(5))
  const label = birth.name.charAt(0).toUpperCase() + birth.name.slice(1)
  return { answer: label + ' tem **' + age + (age === 1 ? ' ano' : ' anos') +
    '** em ' + options.today.split('-').reverse().join('/') + '. Usei a data de nascimento salva na memória (' +
    birth.formatted + ').', contexts: 1, sources: [] }
}

function weekStart(today) {
  const day = new Date(today + 'T00:00:00Z')
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
  return day.toISOString().slice(0, 10)
}

function collectEvidence(state, options) {
  const { account, chat, person, allAccounts, people, personKey, titleFor, today, now, localDay } = options
  const scoped = id => id === account.id || (allAccounts && account.mode === 'local')
  const tokens = words(options.question)
  const relatedTokens = words(options.relatedQuestion).filter(word => !tokens.includes(word))
  const query = normalize(options.question)
  const automatic = Boolean(options.automatic)
  const asksMemory = /\b(memoria|memorias|lembrar|anotacoes|anotei)\b/.test(query)
  const asksSkills = /\bskills?\b/.test(query)
  const asksPending = /\b(pendentes?|pendencias?|em aberto|falta fazer)\b/.test(query)
  const fromDate = options.since || (/\b(esta|essa|desta|nesta|nessa) semana\b/.test(query) ? weekStart(today) : '')
  const directory = new Map(people.map(item => [item.id, item]))
  const name = key => {
    const item = directory.get(key)
    return item?.profile?.name || item?.suggestedName || key
  }
  const matches = value => {
    const text = normalize(value)
    return tokens.reduce((count, word) => count + Number(text.includes(word)), 0) +
      Math.min(2, relatedTokens.reduce((count, word) => count + (text.includes(word) ? 0.5 : 0), 0))
  }
  const namedPeople = new Set(people.filter(item => words(name(item.id)).some(word => tokens.includes(word))).map(item => item.id))
  const messageLookup = new Map(state.messages.map(message => [JSON.stringify([message.account, message.chat, message.id]), message]))
  const related = (accountId, chatId, messageId) => {
    if (!scoped(accountId) || (chat && chat !== chatId)) return false
    if (!person) return true
    const source = messageLookup.get(JSON.stringify([accountId, chatId, messageId]))
    return personKey(accountId, chatId) === person.id ||
      Boolean(source && !source.fromMe && personKey(accountId, source.sender) === person.id)
  }
  const evidence = []
  const push = (type, text, { account: accountId, chat: chatId, source, timestamp, observedDay, author, priority = 0 } = {}) => {
    if (!text || (automatic && timestamp > now) ||
        (automatic && accountId === account.id && chatId === options.currentChat && source === options.excludeMessage)) return
    const conversation = chatId ? titleFor(accountId, chatId) : ''
    const day = observedDay || (timestamp ? localDay(timestamp) : '')
    if (day && ((fromDate && day < fromDate) || (options.until && day > options.until))) return
    const matched = matches([text, conversation, author].join(' '))
    if (automatic && !matched) return
    const score = matched + priority
    evidence.push({ type, text: String(text).slice(0, 1700), account: accountId, chat: chatId, source,
      conversation, author, day, timestamp: timestamp || 0, score })
  }
  for (const item of state.actions) {
    const id = item.latest || item.source
    if (!related(item.account, item.chat, id)) continue
    const original = messageLookup.get(JSON.stringify([item.account, item.chat, id]))
    const author = name(personKey(item.account, item.sender)) || item.sender
    if (asksPending && !['open', 'snoozed'].includes(item.status) && !matches(item.title)) continue
    push('pendência registrada', [item.title, 'Estado: ' + ({
      open:'aberta', done:'concluída', snoozed:'adiada', dismissed:'descartada'
    }[item.status] || item.status), item.due && 'Prazo: ' + item.due,
      item.possiblyResolved && 'Há sinal de possível resolução, ainda sem baixa'].filter(Boolean).join(' · '), {
      account: item.account, chat: item.chat, source: id, author, timestamp: original?.timestamp,
      priority: asksPending && ['open', 'snoozed'].includes(item.status) ? 20 : 2
    })
  }
  for (const item of state.messages) {
    if (automatic && item.status === 'pending') continue
    if (!related(item.account, item.chat, item.id)) continue
    const key = item.fromMe ? null : personKey(item.account, item.sender)
    const author = item.fromMe ? 'Eu' : name(key) || item.sender
    const extracted = item.mediaContext && item.extracted ? mediaExcerpt(item.extracted, 1300, matches) : item.extracted
    const coverage = item.mediaContext?.kind === 'pdf' && item.mediaContext.partial
      ? 'Leitura parcial do PDF (' + item.mediaContext.read + '/' + item.mediaContext.pages + ' páginas).' : ''
    const text = [item.body?.slice(0, item.mediaContext ? 250 : undefined), coverage, item.transcript || extracted || item.caption]
      .filter(Boolean).join('\n')
    if (!fromDate && tokens.length && !person && !namedPeople.has(key) && !matches([text, author, titleFor(item.account, item.chat)].join(' '))) continue
    push(item.fromDeletedArchive ? 'cópia arquivada de mensagem apagada' : 'mensagem', text, { account: item.account, chat: item.chat, source: item.id, timestamp: item.timestamp,
      author, priority: namedPeople.has(key) ? 6 : 0 })
  }
  if (!person) {
    for (const [groupId, profile] of Object.entries(state.groupProfiles || {})) {
      if (chat && groupId !== chat) continue
      const text = [profile.name, profile.purpose, profile.responsibilities].filter(Boolean).join(' · ')
      if (chat === groupId || matches(text)) {
        push('perfil compartilhado do grupo', text, { account: account.id, chat: groupId, priority: 4 })
      }
    }
    for (const [key, context] of Object.entries(state.conversationContexts)) {
      const [owner, conversation] = JSON.parse(key)
      if (!related(owner, conversation)) continue
      const text = [...Object.values(context.profile || {}), context.history?.summary].filter(Boolean).join('\n')
      if (!fromDate && (chat || matches(text) || matches(titleFor(owner, conversation)))) {
        push('contexto da conversa', text, { account: owner, chat: conversation, priority: 2 })
      }
    }
    for (const summary of state.summaries) {
      if (!related(summary.account, summary.chat) || (fromDate && summary.date < fromDate)) continue
      for (const [section, items] of Object.entries(summary.sections || {})) {
        for (const item of items || []) {
          if (!fromDate && !chat && tokens.length && !matches(item.text)) continue
          push('resumo: ' + section, item.text, { account: summary.account, chat: summary.chat,
            source: item.sourceIds?.[0], observedDay: summary.date, priority: fromDate ? 5 : 2 })
        }
      }
    }
  }
  for (const entry of people) {
    if (!(person?.id === entry.id || (!person && namedPeople.has(entry.id)))) continue
    if (entry.accounts.length && !entry.accounts.some(scoped)) continue
    push('perfil cadastrado', Object.values(entry.profile || {}).filter(Boolean).join('\n'), { author: name(entry.id), priority: 8 })
    for (const note of entry.observations || []) {
      if (!related(note.account, note.chat, note.source)) continue
      push('observação sobre pessoa', note.text, { ...note, author: name(entry.id), priority: 4 })
    }
  }
  for (const memory of rememberedPrompts(state, options)) {
    const { item, topic } = memory
    const birth = birthMemory(memory)
    const text = birth ? birth.name + ' nasceu em ' + birth.formatted + '. Data de nascimento registrada pelo usuário.'
      : [topic && 'Assunto da consulta anterior: ' + topic.slice(0, 250), item.prompt].filter(Boolean).join('\n')
    if (tokens.length && !asksMemory && !matches(text)) continue
    push('memória anotada pelo usuário', text, { account: item.account, chat: item.chat,
      timestamp: item.timestamp, priority: 9 })
  }
  if (!automatic && asksSkills && !person && !chat && !fromDate) {
    for (const skill of state.aiSkills) push('skill cadastrada', skill.name, { priority: 5 })
  }
  return evidence.sort((a, b) => b.score - a.score || b.timestamp - a.timestamp)
    .slice(0, automatic ? 8 : asksPending ? 35 : 24).map(({ score, timestamp, ...item }, index) => ({ ...item, ref: 'F' + (index + 1) }))
}

module.exports = { answerAgeFromMemory, collectEvidence }
