// Executed inside the WhatsApp page. Return only one window across the browser boundary.
async function readChatWindow(chatId, cursor, loadEarlier) {
  const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
  if (!chat) throw new Error('Conversa indisponível.')
  const collected = new Map()
  const seen = new Set()
  const started = Date.now()
  const messageId = model => model.id?._serialized || model.id?.$1
  function collect(models) {
    for (const model of models) {
      const id = messageId(model)
      if (id) seen.add(id)
      if (id && !model.isNotification) collected.set(id, model)
    }
  }
  function eligible() {
    return [...collected.values()].filter(model => !cursor || model.t * 1000 < cursor.timestamp ||
      (model.t * 1000 === cursor.timestamp && messageId(model) < cursor.id))
  }
  collect(chat.msgs.getModelsArray())
  let exhausted = false
  let rows = eligible()
  const shouldLoad = loadEarlier && (cursor || !rows.length)
  while (shouldLoad && rows.length < 61) {
    if (Date.now() - started > 20000) throw new Error('O WhatsApp ainda está carregando o histórico. Tente novamente.')
    const previous = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat })
    if (!previous?.length) { exhausted = true; break }
    const count = seen.size
    collect(previous)
    collect(chat.msgs.getModelsArray())
    if (seen.size === count) {
      throw new Error('O WhatsApp ainda não disponibilizou a próxima página. Tente novamente.')
    }
    rows = eligible()
  }
  rows.sort((a, b) => a.t - b.t || (messageId(a) < messageId(b) ? -1 : 1))
  const page = rows.slice(-61)
  const reactions = {}
  await Promise.all(page.filter(model => model.hasReaction).map(async model => {
    try {
      const group = await window.require('WAWebCollections').Reactions.find(messageId(model))
      reactions[messageId(model)] = (group?.reactions?.serialize() || []).map(item => ({
        emoji: item.aggregateEmoji || item.id, count: item.senders?.length || 0, mine: Boolean(item.hasReactionByMe)
      }))
    } catch { /* The reaction collection can still be synchronizing. */ }
  }))
  return { models: page.map(model => window.WWebJS.getMessageModel(model)), reactions, exhausted }
}

function beforeMessage(message, cursor) {
  return !cursor || message.timestamp < cursor.timestamp || (message.timestamp === cursor.timestamp && message.id < cursor.id)
}

function compareMessages(a, b) {
  return a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

module.exports = { readChatWindow, beforeMessage, compareMessages }
