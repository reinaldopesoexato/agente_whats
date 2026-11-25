const id = 'builtin-whatsapp-send'
const skill = {
  id, name: 'Enviar ou responder no WhatsApp', builtin: true,
  prompt: 'Prepare um envio para um contato ou grupo. Identifique a conta pela conversa e permita citar uma mensagem específica.',
  aliases: ['enviar mensagens', 'envio de mensagens', 'enviar mensagem'],
  triggers: ['envie', 'mande', 'responda']
}

const clean = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
const phoneOf = value => /^[+\d()\s-]+$/.test(value) ? value.replace(/\D/g, '') : ''
const command = /^(?:por favor[,]?\s+)?\/?(envie|envia|enviar|mande|manda|mandar|responda|responde|responder)(?=\s|:|$)/i
const quotedBody = /^(?:"([^"]+)"|“([^”]+)”|'([^']+)'|‘([^’]+)’)/u
const nameKey = value => clean(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const stripArticle = value => value.replace(/^(?:a|o)\s+/i, '')
const recipientPronoun = /^(?:ela|ele|elas|eles)$/i

function unquote(text) {
  const match = quotedBody.exec(text)
  return match?.[0] === text ? match.slice(1).find(Boolean) : text
}

function parseCommand(prompt, explicit) {
  const match = command.exec(prompt)
  if (!match && !explicit) return null
  const reply = Boolean(match && /^resp/i.test(match[1]))
  const input = prompt.slice(match?.[0].length || 0).trim().replace(/^uma mensagem\s+/i, '')
  const quoted = quotedBody.exec(input)
  const tail = quoted ? input.slice(quoted[0].length).trim() : ''
  const startsWithTarget = /^(?:para|pra|pro|ao|à|pela|na|usando a|conta|(?:a|à)\s+[úu]ltima|[úu]ltima)\b/i.test(input)
  const split = !startsWithTarget && !quoted
    ? /^([\s\S]+)\s+(?:para|pra|pro|ao|à)\s+([^\n:]+)$/i.exec(input) : null
  const colon = input.indexOf(':')
  let target
  let text
  if (quoted && (!tail || /^(?:para|pra|pro|ao|à|pela|na|usando a|conta)\s+/i.test(tail))) {
    target = tail
    text = quoted.slice(1).find(Boolean)
  } else if (split) {
    target = split[2]
    text = split[1]
  } else if (colon >= 0) {
    target = input.slice(0, colon).trim()
    text = input.slice(colon + 1)
  } else {
    return { error: 'Informe o destinatário e o texto. Exemplo: Envie "Chego às 15h" para Larissa.' }
  }
  text = unquote(text.trim())
  if (!text.trim() || text.length > 4000) return { error: 'Escreva a mensagem que deseja enviar, com até 4000 caracteres.' }
  const firstAccount = /^(?:(?:pela|na|usando a)\s+conta|conta)\s+(.+?)\s+(?:para|pra|pro|ao|à)\s+(.+)$/i.exec(target)
  const lastAccount = /(?:^|\s)(?:(?:pela|pela minha|na|usando a)\s+conta|conta)\s+([^:]+)$/i.exec(target)
  const accountName = firstAccount?.[1] || lastAccount?.[1] || ''
  if (firstAccount) target = firstAccount[2]
  else if (lastAccount) target = target.slice(0, lastAccount.index).trim()
  target = target.replace(/^(?:a|à)?\s*[úu]ltima\s+mensagem\s+(?:de|do|da)\s+/i, '')
    .replace(/^(?:para|pra|pro|ao|à)\s+/i, '').trim()
  if (/^(?:a|à)?\s*[úu]ltima(?:\s+mensagem)?$/i.test(target)) target = ''
  return { reply, text, target: unquote(target), accountName: accountName.trim() }
}

function continueDelivery(prompt, lastTurn, earlierDelivery) {
  const parsed = parseCommand(prompt)
  if (parsed && recipientPronoun.test(parsed.target || '')) {
    return earlierDelivery ? { ...parsed, target: earlierDelivery.recipient, reference: earlierDelivery }
      : { ...parsed, error: 'A quem devo enviar? Informe o nome ou telefone do destinatário.' }
  }
  if (parsed) return parsed
  if (!lastTurn?.error || !/^(?:Destinatário não encontrado|Mais de um destinatário|A quem devo enviar|Separe o destinatário)/.test(lastTurn.error)) return null
  const previous = lastTurn.deliveryCommand || parseCommand(lastTurn.prompt, lastTurn.skill?.builtin || lastTurn.skill?.id === id)
  if (!previous?.text) return null
  const name = prompt.replace(/^(?:para|pra|pro|ao|à)\s+/i, '').trim()
  if (!phoneOf(name) && !/^[\p{L}][\p{L}\p{M}\p{N}\p{Extended_Pictographic}'’. -]{0,99}$/u.test(name)) return null
  return { reply: previous.reply, text: previous.text, target: name, accountName: previous.accountName }
}

function selectTarget({ command, accounts, candidates, scope, quote }) {
  const strict = command.accountName ? accounts.filter(account =>
    clean(account.name) === clean(command.accountName) ||
    (phoneOf(command.accountName) && phoneOf(command.accountName) === account.number)) : null
  if (strict && strict.length !== 1) throw new Error('Informe exatamente o nome da conta que deve enviar a mensagem.')
  const allowed = account => !strict || account === strict[0].id
  if (quote) {
    if (!allowed(quote.account)) throw new Error('A conta indicada é diferente da conta da mensagem citada.')
    return quote
  }
  if (!command.target) {
    if (scope && allowed(scope.account)) return scope
    throw new Error('Informe o destinatário ou abra a conversa que deseja usar.')
  }
  const phone = phoneOf(command.target)
  if (command.reference) {
    const reference = candidates.find(item => item.account === command.reference.account && item.chat === command.reference.chat)
    if (reference && allowed(reference.account)) return reference
    if (!strict) throw new Error('Destinatário não encontrado na conversa usada antes. Informe o nome ou telefone.')
  }
  const searched = nameKey(command.target)
  const withoutArticle = stripArticle(searched)
  const rankName = name => {
    const key = nameKey(name)
    if (!key || !searched) return 0
    if (key === searched) return 3
    if (key === withoutArticle) return 2
    if (key.startsWith(withoutArticle + ' ') || key.startsWith(searched + ' ')) return 1
    return 0
  }
  const rank = item => phone ? (item.phone === phone ? 3 : 0) : Math.max(0, ...item.names.map(rankName))
  const matches = candidates.filter(item => allowed(item.account)).map(item => ({ item, rank: rank(item) }))
  const best = matches.reduce((value, match) => Math.max(value, match.rank), 0)
  const eligible = best ? matches.filter(match => match.rank === best).map(match => match.item) : []
  if (new Set(eligible.map(item => item.identity)).size > 1) {
    throw new Error('Mais de um destinatário tem esse nome. Informe o nome completo ou o telefone.')
  }
  if (eligible.length) {
    const connected = new Set(accounts.filter(account => account.connected).map(account => account.id))
    const ranked = eligible.slice().sort((a, b) => Number(b.account === scope?.account && b.chat === scope.chat) -
      Number(a.account === scope?.account && a.chat === scope.chat) ||
      Number(connected.has(b.account)) - Number(connected.has(a.account)) || b.latest - a.latest)
    return ranked[0]
  }
  if (phone && /^[1-9]\d{7,14}$/.test(phone)) {
    const available = accounts.filter(item => allowed(item.id) && item.connected)
    if (available.length !== 1) throw new Error('Para um número sem conversa anterior, indique a conta de envio.')
    return { account: available[0].id, chat: phone + '@c.us', name: '+' + phone, unverifiedPhone: phone }
  }
  throw new Error('Destinatário não encontrado. Use o nome da conversa, o telefone com DDI ou a conversa aberta.')
}

module.exports = { messageSkill: skill, parseCommand, continueDelivery, selectTarget }
