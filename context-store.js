const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const id = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 20)
const title = value => String(value || '').replace(/[\[\]|\r\n]/g, ' ').trim()
const date = value => Number.isFinite(value) ? new Date(value).toISOString() : ''
const link = (file, label) => `[[${file}|${title(label) || 'Abrir nota'}]]`
const chatFile = (account, chat) => 'Conversas/' + id(JSON.stringify([account, chat]))
const groupFile = group => 'Grupos/' + id(group)
const personFile = person => 'Pessoas/' + id(person)
const actionFile = action => 'Pendencias/' + id(action)
const sourceBlock = source => 'msg-' + id(source)
const quote = text => String(text || '').split(/\r?\n/).map(line => '> ' + line).join('\n')

function write(root, file, content) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === content) return
  fs.writeFileSync(target + '.tmp', content, { mode: 0o600 })
  fs.renameSync(target + '.tmp', target)
}

function exportVault(root, state, people, personKey, removedQueries = []) {
  const notes = new Map()
  const chats = new Map()
  const accounts = new Map(state.accounts.map(account => [account.id, account]))
  const accountName = id => accounts.get(id)?.name || id
  const names = new Map(people.map(person => [person.id, person.profile.name || person.suggestedName || person.id]))
  const messageFiles = new Map()
  const calendar = new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.SUMMARY_TZ || 'America/Sao_Paulo' })
  const dayOf = timestamp => Number.isFinite(timestamp) ? calendar.format(timestamp) : 'sem-data'
  const getChat = (account, chat) => {
    const file = chatFile(account, chat)
    if (!chats.has(file)) {
      const context = state.conversationContexts[JSON.stringify([account, chat])] || {}
      const name = context.title || accounts.get(account)?.chatNames?.[chat] || chat
      chats.set(file, { file, name, account, chat, context, days: new Map(), people: new Set(), actions: [], summaries: [] })
    }
    return chats.get(file)
  }
  const source = (account, chat, message) => {
    const file = messageFiles.get(JSON.stringify([account, chat, message]))
    return file ? link(file + '#^' + sourceBlock(message), 'Mensagem de origem') : link(chatFile(account, chat), 'Conversa de origem')
  }
  const add = (file, body) => notes.set(file + '.md', body + '\n')
  const index = (section, label, entries) => {
    add(section + '/Indice', '# ' + label + '\n\n' + (entries.length ? entries.map(item => '- ' + item).join('\n') : 'Nenhum registro.'))
  }

  for (const key of Object.keys(state.conversationContexts)) getChat(...JSON.parse(key))
  for (const account of accounts.values()) {
    for (const chat of Object.keys(account.chatNames || {})) {
      if (chat.endsWith('@g.us')) getChat(account.id, chat)
    }
  }
  for (const person of people) {
    for (const item of person.chats) {
      const chat = getChat(item.account, item.chat)
      if (chat.name === item.chat && item.title) chat.name = item.title
      chat.people.add(person.id)
    }
  }
  for (const message of state.messages) {
    if (!message.chat) continue
    const chat = getChat(message.account, message.chat)
    const day = dayOf(message.timestamp)
    if (!chat.days.has(day)) chat.days.set(day, [])
    chat.days.get(day).push(message)
    messageFiles.set(JSON.stringify([message.account, message.chat, message.id]), chat.file + '/' + day)
  }
  for (const action of state.actions) {
    const chat = getChat(action.account, action.chat)
    chat.actions.push(link(actionFile(action.id), action.title))
    add(actionFile(action.id), [
      '# ' + title(action.title), 'Estado: **' + ({open:'Aberta', done:'Concluída', snoozed:'Adiada', dismissed:'Descartada'}[action.status] || action.status) + '**',
      action.due ? 'Prazo: ' + action.due : '', 'Conta: ' + accountName(action.account), link(chat.file, chat.name),
      source(action.account, action.chat, action.source),
      action.latest && action.latest !== action.source ? source(action.account, action.chat, action.latest) : '',
      action.possiblyResolved ? 'Possível resolução: ' + source(action.account, action.chat, action.possiblyResolved) : ''
    ].filter(Boolean).join('\n\n'))
  }
  for (const summary of state.summaries) {
    const chat = getChat(summary.account, summary.chat)
    if (summary.chatName && !chat.context.title) chat.name = summary.chatName
    const file = 'Resumos/' + id(JSON.stringify([summary.account, summary.chat, summary.date]))
    chat.summaries.push(link(file, summary.date))
    const labels = { issues:'Problemas', suggestions:'Sugestões', recurring:'Recorrências', actions:'Ações', resolved:'Resolvidos' }
    const sections = Object.entries(summary.sections || {}).flatMap(([key, items]) => items?.length ? [
      '## ' + (labels[key] || key), ...items.map(item => quote(item.text) + '\n\n' +
        (item.sourceIds || []).map(message => source(summary.account, summary.chat, message)).join(' · '))
    ] : [])
    add(file, ['# ' + title(chat.name) + ' · ' + summary.date, link(chat.file, chat.name), ...sections].join('\n\n'))
  }
  for (const chat of chats.values()) {
    const days = [...chat.days.keys()].sort().reverse()
    for (const day of days) {
      const messages = chat.days.get(day).sort((a, b) => a.timestamp - b.timestamp)
      const body = messages.map(item => {
        const person = !item.fromMe && personKey(item.account, item.sender)
        const sender = item.fromMe ? 'Eu' : person && names.has(person) ? link(personFile(person), names.get(person)) : title(item.sender)
        const content = [item.body, item.transcript || item.extracted || item.caption].filter(Boolean).join('\n\n')
        return [date(item.timestamp) + ' · ' + sender, quote(content || (item.media ? 'Anexo registrado sem texto extraído.' : '')), '^' + sourceBlock(item.id)].join('\n\n')
      }).join('\n\n---\n\n')
      add(chat.file + '/' + day, '# ' + title(chat.name) + ' · ' + day + '\n\n' + link(chat.file, chat.name) + '\n\n' + body)
    }
    const { profile, history, memory } = chat.context
    add(chat.file, ['# ' + title(chat.name), 'Conta: ' + accountName(chat.account),
      chat.chat.endsWith('@g.us') ? link(groupFile(chat.chat), 'Grupo compartilhado') : '',
      ...Object.entries(profile || {}).filter(([, value]) => value).map(([key, value]) => '**' + ({
        purpose:'Finalidade', participants:'Participantes', vocabulary:'Vocabulário', priorities:'Prioridades'
      }[key] || key) + '**\n\n' + quote(value)),
      history?.summary ? '## Contexto do histórico\n\n' + quote(history.summary) : '',
      memory?.length ? '## Fatos recentes\n\n' + memory.map(item =>
        quote(item.text) + '\n\n' + source(chat.account, chat.chat, item.source)).join('\n\n') : '',
      chat.people.size ? '## Pessoas\n\n' + [...chat.people].map(person => '- ' + link(personFile(person), names.get(person))).join('\n') : '',
      chat.actions.length ? '## Pendências\n\n' + chat.actions.map(item => '- ' + item).join('\n') : '',
      chat.summaries.length ? '## Resumos\n\n' + chat.summaries.map(item => '- ' + item).join('\n') : '',
      days.length ? '## Mensagens por dia\n\n' + days.map(day => '- ' + link(chat.file + '/' + day, day)).join('\n') : ''
    ].filter(Boolean).join('\n\n'))
  }
  const sharedGroups = new Map(Object.keys(state.groupProfiles || {}).map(chat => [chat, []]))
  for (const chat of chats.values()) {
    if (!chat.chat.endsWith('@g.us')) continue
    if (!sharedGroups.has(chat.chat)) sharedGroups.set(chat.chat, [])
    sharedGroups.get(chat.chat).push(chat)
  }
  const groupLinks = []
  for (const [id, accounts] of sharedGroups) {
    const profile = state.groupProfiles?.[id] || {}
    const name = profile.name || accounts[0]?.name || id
    const fields = Object.entries({ purpose: 'Finalidade', responsibilities: 'Responsabilidades', instructions: 'Instruções para a I.A.' })
      .filter(([key]) => profile[key]).map(([key, label]) => '**' + label + '**\n\n' + quote(profile[key]))
    add(groupFile(id), ['# ' + title(name), ...fields, ...accounts.map(chat => [
      '## ' + title(accountName(chat.account)), link(chat.file, chat.name),
      chat.context.history?.summary ? quote(chat.context.history.summary) : ''
    ].filter(Boolean).join('\n\n'))].join('\n\n'))
    groupLinks.push(link(groupFile(id), name))
  }
  for (const person of people) {
    const profile = Object.entries(person.profile).filter(([, value]) => value).map(([key, value]) => '**' + ({
      name:'Nome', relationship:'Vínculo', organization:'Empresa', responsibilities:'Responsabilidades',
      personalTopics:'Assuntos pessoais', companyTopics:'Assuntos profissionais', instructions:'Instruções para a I.A.'
    }[key] || key) + '**\n\n' + quote(value))
    add(personFile(person.id), ['# ' + title(names.get(person.id)), ...profile,
      person.chats.length ? '## Conversas\n\n' + person.chats.map(item => '- ' + link(chatFile(item.account, item.chat), item.title)).join('\n') : '',
      person.observations.length ? '## Observações\n\n' + person.observations.map(item => quote(item.text) + '\n\n' + source(item.account, item.chat, item.source)).join('\n\n') : ''
    ].filter(Boolean).join('\n\n'))
  }
  for (const skill of state.aiSkills) {
    const rule = skill.automation
    const runs = rule || skill.description ? (state.skillRuns || []).filter(run => run.skill === skill.id).slice(-20).reverse() : []
    add('Skills/' + id(skill.id), ['# ' + title(skill.name), quote(skill.description || skill.prompt),
      rule && (rule.enabled ? 'Automática e ativa' : 'Automática e desativada'),
      rule?.group && link(groupFile(rule.group), 'Grupo'),
      rule?.person && link(personFile(rule.person), names.get(rule.person)),
      runs.length && '## Execuções recentes\n\n' + runs.map(run =>
        '- ' + dayOf(run.created) + ' · ' + ({
          queued: 'Na fila', sending: 'Enviando', done: 'Concluída', review: 'Em revisão',
          uncertain: 'Sem confirmação', canceled: 'Cancelada', dismissed: 'Dispensada'
        }[run.status] || run.status) + ' · ' + source(run.account, run.chat, run.source)).join('\n')
    ].filter(Boolean).join('\n\n'))
  }
  const queries = new Map()
  const memoryLinks = []
  for (const item of state.aiQueries) {
    const stamp = dayOf(item.timestamp)
    const section = [date(item.timestamp), 'Conta: ' + accountName(item.account),
      item.chat ? link(chatFile(item.account, item.chat), 'Conversa') : '',
      item.person ? link(personFile(item.person), names.get(item.person)) : '',
      '**Prompt**\n\n' + quote(item.prompt),
      item.answer ? '**Resposta da I.A.**\n\n' + quote(item.answer) : '',
      ...(item.sources || []).map(item => item.ref + ' · ' + source(item.account, item.chat, item.source))
    ].filter(Boolean).join('\n\n')
    if (!queries.has(stamp)) queries.set(stamp, [])
    queries.get(stamp).push(section)
    if (item.remember) {
      const file = 'Memorias/' + id(item.id)
      add(file, ['# Memória solicitada em ' + stamp, section, link('Consultas/' + stamp, 'Consulta original')].join('\n\n'))
      memoryLinks.unshift(link(file, item.prompt.slice(0, 95)))
    }
  }
  for (const [stamp, items] of queries) add('Consultas/' + stamp, '# Consultas · ' + stamp + '\n\n' + items.join('\n\n---\n\n'))
  index('Conversas', 'Conversas', [...chats.values()].map(chat => link(chat.file, accountName(chat.account) + ' · ' + chat.name)))
  index('Grupos', 'Grupos', groupLinks)
  index('Pessoas', 'Pessoas', people.map(person => link(personFile(person.id), names.get(person.id))))
  index('Pendencias', 'Pendências', state.actions.map(action => link(actionFile(action.id), action.title + ' · ' + ({
    open:'Aberta', done:'Concluída', snoozed:'Adiada', dismissed:'Descartada'
  }[action.status] || action.status))))
  index('Resumos', 'Resumos', [...chats.values()].flatMap(chat => chat.summaries.map(item => item + ' · ' + title(chat.name))))
  index('Skills', 'Skills', state.aiSkills.map(skill => link('Skills/' + id(skill.id), skill.name)))
  index('Memorias', 'Memórias da I.A.', memoryLinks)
  index('Consultas', 'Histórico de consultas', [...queries.keys()].sort().reverse().map(stamp => link('Consultas/' + stamp, stamp)))
  add('Inicio', '# WhatsIA pessoal\n\n' + Object.entries({
    Conversas:'Conversas', Pessoas:'Pessoas', Grupos:'Grupos', Pendencias:'Pendências', Resumos:'Resumos',
    Skills:'Skills', Memorias:'Memórias da I.A.', Consultas:'Histórico de consultas'
  }).map(([folder, label]) => '- ' + link(folder + '/Indice', label)).join('\n'))
  for (const [file, content] of notes) write(root, file, content)
  for (const item of removedQueries) {
    const day = dayOf(item.timestamp)
    if (!queries.has(day)) fs.rmSync(path.join(root, 'Consultas', day + '.md'), { force: true })
    if (item.remember) fs.rmSync(path.join(root, 'Memorias', id(item.id) + '.md'), { force: true })
  }
}

module.exports = { exportVault, write }
