const { randomUUID } = require('node:crypto')

const eligible = (record, filter) => Number.isFinite(record.liveReceivedAt) && !record.fromMe &&
  record.integration !== false && (!filter.account || record.account === filter.account) &&
  (!filter.chat || record.chat === filter.chat)

function inboxOperation(state, input, now = Date.now()) {
  const { consumer, action } = input || {}
  const fail = (status, error) => ({ status, body: { error } })
  if (typeof consumer !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(consumer)) {
    return fail(400, 'Informe um identificador de consumidor válido.')
  }
  const consumers = state.integrationConsumers ??= {}
  const subscription = Object.hasOwn(consumers, consumer) ? consumers[consumer] : null
  if (action === 'register') {
    const { account, chat, from = 'now' } = input
    if ((account != null && !state.accounts.some(item => item.id === account)) ||
        (chat != null && (typeof chat !== 'string' || !chat || !account)) ||
        !['now', 'stored'].includes(from)) return fail(400, 'Escopo ou ponto inicial inválido.')
    if (subscription) return fail(409, 'Consumidor já cadastrado. Escolha outro nome para mudar o escopo.')
    Object.defineProperty(consumers, consumer, { enumerable: true, writable: true, configurable: true,
      value: { account: account ?? null, chat: chat ?? null, next: from === 'now' ? state.messages.length : 0 } })
    return { status: 201, body: { consumer, account: account ?? null, chat: chat ?? null, from }, changed: true }
  }
  if (!subscription) return fail(404, 'Consumidor não cadastrado.')
  const lease = subscription.lease?.expiresAt > now ? subscription.lease : null
  if (action === 'renew') {
    if (!lease || input.lease !== lease.id) return fail(409, 'Reserva inválida ou expirada.')
    const { seconds = 300 } = input
    if (!Number.isInteger(seconds) || seconds < 30 || seconds > 3600) return fail(400, 'Use uma reserva de 30 a 3600 segundos.')
    lease.expiresAt = Math.max(lease.expiresAt, now + seconds * 1000)
    return { status: 200, body: { consumer, lease: lease.id, expiresAt: lease.expiresAt }, changed: true }
  }
  if (action === 'ack' && input.lease && subscription.lastAck === input.lease) {
    return { status: 200, body: { consumer, acknowledged: true } }
  }
  if (action === 'ack' || action === 'release') {
    if (!lease || input.lease !== lease.id) return fail(409, 'Reserva inválida ou expirada.')
    if (action === 'ack') {
      subscription.next = lease.end
      subscription.lastAck = lease.id
    }
    delete subscription.lease
    return { status: 200, body: { consumer, acknowledged: action === 'ack' }, changed: true }
  }
  if (action === 'check') {
    let pending = 0
    for (let index = subscription.next; index < state.messages.length; index++) {
      if (eligible(state.messages[index], subscription)) pending++
    }
    return { status: 200, body: { consumer, pending, available: lease ? 0 : pending, reservedUntil: lease?.expiresAt ?? null } }
  }
  if (action !== 'claim') return fail(400, 'Operação de fila desconhecida.')
  if (lease) return fail(409, 'Já existe uma reserva ativa para este consumidor.')
  const { limit = 20, seconds = 300 } = input
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(seconds) || seconds < 30 || seconds > 3600) {
    return fail(400, 'Use limite de 1 a 100 e reserva de 30 a 3600 segundos.')
  }
  const messages = []
  let end = subscription.next
  while (end < state.messages.length && messages.length < limit) {
    const record = state.messages[end++]
    if (!eligible(record, subscription)) continue
    const { id, account, chat, sender, body, media, timestamp, liveReceivedAt } = record
    messages.push({ id, account, chat, sender, body: body || '', media: Boolean(media), timestamp, receivedAt: liveReceivedAt })
  }
  if (!messages.length) {
    subscription.next = end
    delete subscription.lease
    return { status: 200, body: { consumer, lease: null, messages }, changed: true }
  }
  subscription.lease = { id: randomUUID(), expiresAt: now + seconds * 1000, end }
  return { status: 200, body: { consumer, lease: subscription.lease.id, expiresAt: subscription.lease.expiresAt, messages }, changed: true }
}

module.exports = { inboxOperation }
