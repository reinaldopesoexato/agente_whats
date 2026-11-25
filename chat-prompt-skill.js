const { createHash } = require('node:crypto')

const normalize = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

function isChatPromptSkill(skill) {
  const description = normalize(skill.description)
  return /\/ia\b/.test(description) && /\b(?:inicie|comece)\b/.test(description) &&
    /\bremetente\b/.test(description) && /\blarissa\b/.test(description) &&
    /\breinaldo\b/.test(description) && /\b(?:responda|resposta)\b/.test(description)
}

function readChatPrompt(body) {
  return typeof body === 'string' ? /^\/ia(?=\s|$)\s*([\s\S]*)$/i.exec(body)?.[1].trim() ?? null : null
}

function isLarissaName(title) {
  return normalize(title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() === 'larissa'
}

function promptThread(account, chat, member) {
  return 'ia-chat-' + createHash('sha256').update(JSON.stringify([account, chat, member])).digest('hex').slice(0, 24)
}

module.exports = { isChatPromptSkill, readChatPrompt, isLarissaName, promptThread }
