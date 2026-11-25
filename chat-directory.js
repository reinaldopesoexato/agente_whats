const {createWhatsAppFormatting} = require('./public/whatsapp-format')

function listCachedChats(createFormatting) {
  const formatting = createFormatting()
  // A directory refresh usually sees the same message models. Drop entries when WhatsApp releases them.
  const cacheKey = Symbol.for('whatsia.formattedPreview.v1')
  const previous = window[cacheKey] ??= new WeakMap()
  const collections = window.require('WAWebCollections')
  const models = collections.Chat.getModelsArray()
  return models.flatMap(chat => {
    const id = chat.id?._serialized || chat.id?.$1 || (typeof chat.id === 'string' ? chat.id : '')
    if (typeof id !== 'string' || !id) return []
    let title
    try {
      title = chat.formattedTitle
    } catch {
      // A conversa pode ter chegado antes de seus contatos e metadados.
    }
    const received = chat.lastReceivedKey
    const lastId = received?._serialized || received?.$1
    let preview = null
    try {
      const message = lastId && collections.Msg.get(lastId)
      if (message) {
        const media = Boolean(message.directPath || message.mimetype)
        preview = {type:message.type,media,fromMe:Boolean(message.id?.fromMe),text:''}
        if (!media && message.type === 'chat' && typeof message.body === 'string') {
          if (message.body.length <= 140) preview.text = message.body
          else {
            let cached = previous.get(message)
            if (!cached || cached.body !== message.body) {
              cached = {body:message.body,preview:formatting.preview(message.body)}
              previous.set(message,cached)
            }
            Object.assign(preview,cached.preview)
          }
        }
      }
    } catch {
      // Some chats have not loaded their latest message.
    }
    return [{
      id, name: typeof title === 'string' && title ? title : id,
      group: id.endsWith('@g.us'), unread: Number(chat.unreadCount) || 0,
      timestamp: Number(chat.t) || 0, preview
    }]
  })
}
// Puppeteer evaluates this static expression in the WhatsApp page. Both functions come from this module bundle.
module.exports = '(' + listCachedChats.toString() + ')(' + createWhatsAppFormatting.toString() + ')'
