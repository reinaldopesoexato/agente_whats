const { ownerCommand } = require('./owner-channel')

function skillCreationRequest(prompt) {
  const save = /^(?:por favor[,\s]+)?(?:salve?|salva|salvar|guarde|guardar|transforme|transformar|cadastre|registre)\s+(?:(?:isso|isto|esse prompt|este prompt|essa instrução|o prompt anterior)\s+)?(?:como|em)\s+(?:(?:uma|nova)\s+)*skill\b\s*[:,-]?\s*(.*)$/is.exec(prompt.trim())
  if (save) return save[1].trim() ? { details: save[1].trim() } : { previous: true }
  const request = /^(?:por favor[,\s]+)?(?:quero (?:criar |que (?:voc[eê] )?crie )?|gostaria de criar |pode (?:criar|fazer|montar) |(?:salve|salvar|registre|cadastre|crie|criar|cria|fa[cç]a|faz|monte) )(?:(?:para|pra) mim\s+)?(?:(?:uma|a|nova)\s+)*skill\b/i.exec(prompt)
  if (!request) return null
  const details = prompt.slice(request[0].length).trim().replace(/^:\s*/, '')
  if (!details) return { empty: true }
  if (!/^(?:para|que|com)\s/i.test(details)) {
    const explicit = ownerCommand('Crie a skill ' + details)
    if (explicit?.action === 'create') return { fields: explicit }
  }
  return { details }
}

module.exports = { skillCreationRequest }
