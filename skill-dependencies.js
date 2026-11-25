const { messageSkill } = require('./message-skill')

const interceptionSkill = {
  id: 'builtin-whatsapp-intercept', name: 'Interceptar mensagens do WhatsApp', builtin: true,
  prompt: 'Recebe as mensagens novas das contas conectadas e disponibiliza os eventos para as skills.',
  aliases: ['interceptar todas as mensagens', 'interceptar mensagens']
}
const archiveSkill = {
  id: 'builtin-whatsapp-archive', name: 'Salvar mensagens e mídias apagadas', builtin: true,
  prompt: 'Guarda uma cópia local das mensagens e mídias recebidas enquanto a conta está conectada. ' +
    'Quando o WhatsApp informa uma exclusão, oferece a opção Mostrar conteúdo apagado no chat.'
}
const builtinSkills = [messageSkill, interceptionSkill, archiveSkill]
const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function resolveSkillDependencies(skill, skills) {
  const visited = new Set()
  const visiting = new Set()
  const dependencies = []
  const names = skills.flatMap(item => [item.name, ...(item.aliases || [])]
    .map(name => ({ name: normalize(name), item })))
    .sort((a, b) => b.name.length - a.name.length)
  function visit(item) {
    if (visiting.has(item.id)) return 'Dependência circular em ' + item.name + '.'
    if (visited.has(item.id)) return null
    if (item.active === false) return 'Skill desativada: ' + item.name + '.'
    visiting.add(item.id)
    const description = item.description || ''
    const quotedText = [...description.matchAll(/"[^"]*"|“[^”]*”/gu)]
    const pattern = /\b(?:use|usa|usar|utilize|utiliza|utilizar)\s+(?:(?:a|o)\s+)?(skill\s+(?:de\s+)?)?(?:"([^"]+)"|“([^”]+)”|'([^']+)'|([^.!?;\n,]+))/giu
    for (const match of description.matchAll(pattern)) {
      if (quotedText.some(part => match.index > part.index && match.index < part.index + part[0].length)) continue
      const [, explicit, straight, curly, single, unquoted] = match
      const quoted = straight || curly || single
      const name = normalize(quoted || unquoted)
      const resolved = names.find(candidate => candidate.name &&
        (name === candidate.name || (!quoted && name.startsWith(candidate.name + ' '))))
      if (!resolved) {
        if (explicit) return 'Dependência não encontrada: ' + (quoted || unquoted).trim() + '.'
        continue
      }
      const error = visit(resolved.item)
      if (error) return error
    }
    visiting.delete(item.id)
    visited.add(item.id)
    if (item.id !== skill.id) dependencies.push(item)
    return null
  }
  return { error: visit(skill), dependencies }
}

module.exports = { builtinSkills, interceptionSkill, archiveSkill, resolveSkillDependencies }
