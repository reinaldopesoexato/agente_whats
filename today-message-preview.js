// Protocol events can arrive as live messages during synchronization.
const systemTypes = new Set([
  'notification_template','notification','e2e_notification','protocol','gp2','group_notification',
  'broadcast_notification','ciphertext','revoked','reaction','debug','call_log'
])
const typeLabels = new Map(Object.entries({
  image:'Imagem',video:'Vídeo',ptt:'Mensagem de voz',audio:'Áudio',document:'Documento',
  sticker:'Figurinha',album:'Álbum',vcard:'Contato',multi_vcard:'Contatos',location:'Localização',
  poll_creation:'Enquete',scheduled_event_creation:'Evento',groups_v4_invite:'Convite para grupo'
}))

function todayMessagePreview(message) {
  if (message.isNotification || systemTypes.has(message.type)) return ''
  const label = typeLabels.get(message.type) || (message.media ? 'Anexo' : '')
  for (const value of [message.body, message.transcript, message.extracted, message.caption]) {
    if (typeof value !== 'string') continue
    const text = value.trim()
    if (!text || !text.replace(/[\s\u200b-\u200f\ufeff]/gu,'')) continue
    if (/^data:[^,]*;base64,/i.test(text) || (label && /^[a-z0-9+/=]{80}/i.test(text))) continue
    return text.slice(0,300)
  }
  return label
}

module.exports = {todayMessagePreview}
