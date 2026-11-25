const { createHash } = require('node:crypto')

const ownerHeader = 'WhatsIA · I.A.'
const phoneJid = number => /^\d{7,15}$/.test(number || '') ? number + '@c.us' : null
const phoneOf = jid => /^(\d{7,15})@c\.us$/.exec(jid || '')?.[1]

function approvalReply(text) {
  const reply = String(text || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
    .replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  if (/^(?:sim|s|1|ok|okay|claro(?: que sim)?|pode(?: enviar| mandar| sim)?|confirmo|autorizo|aprovo|vai em frente|com certeza|manda|positivo|👍)$/.test(reply)) return 'approve'
  if (/^(?:nao|n|0|nao (?:envie|mande|autorizo|pode)|negativo|recuso|pare|parar|cancele|cancelar|deixa pra la|👎)$/.test(reply)) return 'reject'
  return null
}

function ownerMessagePeer(account, message, accounts, resolve) {
  if (!phoneJid(account.selfNumber) || !message.chat || message.chat.endsWith('@g.us')) return null
  const peerNumber = phoneOf(resolve(account.id, message.chat))
  if (!peerNumber || peerNumber === account.selfNumber ||
      (!message.fromMe && phoneOf(resolve(account.id, message.sender)) !== peerNumber)) return null
  const peers = accounts.filter(item => item.id !== account.id && item.selfNumber === peerNumber)
  return peers.length === 1 ? peers[0] : null
}

function ownerThread(account, peer) {
  const pair = [account.selfNumber, peer.selfNumber].sort()
  return 'whatsapp-' + createHash('sha256').update(pair.join(':')).digest('hex').slice(0, 24)
}

function ownerCommand(prompt) {
  if (/^(?:liste|listar|mostre|minhas)\s+(?:as\s+)?skills[?!.]?$/i.test(prompt)) return { action: 'list' }
  const edit = /^(crie|criar|edite|editar|atualize|atualizar)\s+(?:(?:uma|a)\s+)?skill\s+(?:chamada\s+)?(?:"([^"]+)"|“([^”]+)”|([^:\n]+))\s*:\s*([\s\S]+)$/i.exec(prompt)
  if (edit) return { action: /^cri/i.test(edit[1]) ? 'create' : 'edit',
    name: (edit[2] || edit[3] || edit[4]).trim(), description: edit[5].trim() }
  const toggle = /^(ative|ativar|desative|desativar)\s+(?:a\s+)?skill\s+(.+?)\.?$/i.exec(prompt)
  if (toggle) return { action: 'toggle', name: toggle[2].replace(/^["“]|["”]$/g, '').trim(), active: /^ativ/i.test(toggle[1]) }
  const use = /^(?:use|usa|utilize)\s+(?:a\s+)?skill\s+(?:"([^"]+)"|“([^”]+)”|([^:\n]+))\s*:\s*([\s\S]+)$/i.exec(prompt)
  if (use) return { action: 'use', name: (use[1] || use[2] || use[3]).trim(), prompt: use[4].trim() }
  if (/^(?:crie|criar|edite|editar|atualize|atualizar)\s+(?:(?:uma|a)\s+)?skill\b/i.test(prompt)) return { action: 'help' }
  return null
}

module.exports = { ownerHeader, phoneJid, ownerMessagePeer, ownerThread, ownerCommand, approvalReply }
