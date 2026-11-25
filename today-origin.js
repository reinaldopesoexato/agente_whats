// Fast path for descriptions with a single, explicit source. Other wording goes to the classifier.
function fold(text) {
  return text.normalize('NFKD').replace(/\p{M}/gu,'').replace(/\s+/g,' ').trim().toLowerCase()
}

function originCondition(prompt, origin, isKnownSender) {
  if (!prompt) return
  const text = prompt.trim().replace(/[.!]+$/u,'').replace(/[“”]/g,'"')
  // A disjunction or exception may apply to the whole rule, including the source.
  const unquoted = text.replace(/"[^"]*"/gu,'')
  if (/[;,\n]|\b(?:ou|exceto|salvo|menos|mas|ignore|exclua|tirando)\b/iu.test(unquoted)) return
  const clause = /^(?:(?:agrupe|inclua|categorize|classifique|separe)\s+)?(?:(?:somente|apenas)\s+)?(?:(?:todas\s+)?as?\s+|toda\s+)?mensage(?:m|ns)\s+(?:(enviad[ao]s?|recebid[ao]s?|vind[ao]s?)\s+)?(d[aeo]|por|pel[oa]|no|na)\s+(?:(grupo|pessoa|contato|remetente)\s+)?(.+)$/iu.exec(text)
  if (!clause) return
  const [, verb, prep, kind, tail] = clause
  const group = kind?.toLowerCase() === 'grupo'
  if (!group && /^(no|na)$/i.test(prep)) return
  const parts = tail.match(/^(.*?)\s+(?:sobre|referentes? a|a respeito de)\s+(.+)$/iu)
  let target = (parts?.[1] || tail).trim()
  // A participant may be required to write in one particular group.
  const within = !group && /^(.*?)\s+no grupo\s+(.+)$/iu.exec(target)
  let room
  if (within) {
    room = originCondition('Mensagens do grupo '+within[2],origin)
    if (!room?.matches) return room
    target = within[1]
  }
  const quoted = /^"([^"]+)"$/u.exec(target)
  const name = quoted ? quoted[1] : target
  // Do not mistake alternatives, exclusions, or other qualifications for a person's name.
  const names = group ? origin.nomesDaConversa : origin.nomesDoRemetente
  const actual = (!group || origin.tipoConversa === 'grupo') && names.find(n=>fold(n) === fold(name))
  if (actual && room) return {matches:true,onlyOrigin:!parts,source:'autor',quote:actual,
    reason:`A mensagem foi enviada por ${actual} no grupo ${room.quote}.`}
  if (actual) return {matches:true,onlyOrigin:!parts,source:group ? 'conversa' : 'autor',quote:actual,
    reason:group ? 'A mensagem veio do grupo indicado na descrição.' : 'O remetente da mensagem corresponde ao nome indicado na descrição.'}
  if (!quoted && (!/^[\p{L}\p{N} +.()@'’_-]+$/u.test(name) ||
      /\b(?:que|e|quando|com|sem|para|no|na|se|apenas|somente)\b/iu.test(name))) return
  // A shortened name can be intentional. Let the model interpret it against the supplied identities.
  if ((!group || origin.tipoConversa === 'grupo') && names.some(n=>fold(n).split(/[^\p{L}\p{N}]+/u).includes(fold(name)))) return
  // "Mensagens de orçamento" may describe a subject. Only enforce unambiguous origin restrictions.
  if (group || kind || verb || quoted || /^(por|pelo|pela)$/i.test(prep) || isKnownSender?.(name)) {
    return {matches:false}
  }
}

// Consult only this account's known contacts, locally, to distinguish "de Ana" from "de orçamento".
function knownSenders(state,account) {
  let names
  return name=>{
    if (!names) {
      names = new Set()
      for (const directory of [account.chatNames,state.senderNames?.[account.id]]) {
        for (const [address,label] of Object.entries(directory || {})) {
          if (/^\d+@(c\.us|lid|s\.whatsapp\.net)$/.test(address) && typeof label === 'string') names.add(fold(label))
        }
      }
    }
    return names.has(fold(name))
  }
}

module.exports = {originCondition,knownSenders}
