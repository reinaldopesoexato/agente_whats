const personal = /^(\d+)(?::\d+)?@(c\.us|s\.whatsapp\.net|lid)$/
const serviceTypes = new Set(['gp2','e2e_notification','notification_template','protocol','call_log','group_notification'])

function peerId(wid) {
  const id = typeof wid === 'string' ? wid : wid?._serialized || wid?.$1
  const match = personal.exec(id || '')
  return match ? match[1] + '@' + (match[2] === 'lid' ? 'lid' : 'c.us') : null
}

function contactKey(account, sender) {
  const id = peerId(sender)
  return id?.endsWith('@lid') ? account + '/' + id : id
}

function displayName(...values) {
  return values.find(name => typeof name === 'string' && name.trim() &&
    !/@(?:lid|c\.us|g\.us|s\.whatsapp\.net)$/i.test(name.trim()) && !/^[+\d().\s-]+$/.test(name.trim()))?.trim().slice(0,200)
}

// A group address identifies the conversation. Only a participant can identify its author.
function messageSender(message, chat = message.fromMe ? message.to : message.from) {
  if (message.isNotification || serviceTypes.has(message.type)) return null
  if (message.fromMe) return peerId(message.from) || peerId(message.sender)
  if (chat?.endsWith('@g.us')) {
    const participant = peerId(message.author) || peerId(message.sender) || peerId(message.id?.participant)
    if (participant) return participant
    const id = typeof message.id === 'string' ? message.id : message.id?._serialized || message.id?.$1
    const parts = id?.split('_')
    return parts?.length === 4 && parts[0] === 'false' && parts[1] === chat ? peerId(parts[3]) : null
  }
  if (!peerId(chat)) return null
  return peerId(message.from) || peerId(message.sender) || peerId(chat)
}

// The address book sometimes stores only a LID title, while a saved message uses its verified phone.
function aliasNames(state,account) {
  const names = new Map()
  const prefix = account.id + '/'
  for (const [key,phone] of Object.entries(state.personAliases)) {
    if (!key.startsWith(prefix)) continue
    const lid = key.slice(prefix.length)
    const name = displayName(account.chatNames?.[lid],state.senderNames?.[account.id]?.[lid])
    if (name) names.set(phone,name)
  }
  return names
}

function messageAuthor(state, account, chat, message, aliases) {
  if (message.fromMe) return {senderName:'Você',personId:null}
  if (message.isNotification || serviceTypes.has(message.type)) return {senderName:'WhatsApp',personId:null}
  const sender = messageSender(message,chat)
  const key = contactKey(account.id,sender)
  const personId = state.personAliases[key] || key
  const phone = personId?.endsWith('@c.us') ? personId : null
  const direct = peerId(chat)
  const directKey = contactKey(account.id,direct)
  const directPerson = state.personAliases[directKey] || directKey
  // A stored direct chat can use LID for its address and PN for its incoming message.
  // Do not borrow its title when two known identities disagree.
  const sameChat = direct && (directPerson === personId ||
    (direct.endsWith('@lid') && !state.personAliases[directKey] && sender?.endsWith('@c.us')))
  const names = state.senderNames?.[account.id] || {}
  const senderName = displayName(state.people[personId]?.profile?.name, account.chatNames?.[sender],
    account.chatNames?.[phone], sameChat && account.chatNames?.[direct], names[sender],names[phone],aliases?.get(phone),sender && message.senderHint)
  return {personId,senderName:senderName || (phone ? '+' + phone.split('@')[0] :
    chat.endsWith('@g.us') ? 'Participante sem nome' : 'Contato sem nome')}
}

// Keep names local to this participant and account when evaluating a list description.
function senderNamesForRule(state,account,chat,message,author) {
  if (message.fromMe) return ['Você']
  if (!author.personId) return []
  const sender = messageSender(message,chat)
  const names = state.senderNames?.[account.id] || {}
  const ids = [sender,author.personId]
  const labels = [author.senderName,...ids.flatMap(id=>[account.chatNames?.[id],names[id]]),message.senderHint]
  return [...new Set(labels.filter(label=>label && !['Contato sem nome','Participante sem nome'].includes(label) &&
    (displayName(label) || /^\+\d+$/.test(label))))]
}

// Runs inside the connected WhatsApp Web page. Resolve only the senders in this history window.
async function readAuthorContacts(ids) {
  const contacts = window.require('WAWebCollections').Contact
  const factory = window.require('WAWebWidFactory')
  const getters = window.require('WAWebContactGetters')
  const api = window.require('WAWebApiContact')
  const rows = []
  const pending = Promise.all(ids.map(async id => {
    try {
      const wid = factory.createWid(id)
      const alt = api.getAlternateUserWid?.(wid) || (wid.server === 'lid' ? api.getPhoneNumber?.(wid) : api.getCurrentLid?.(wid))
      const stringify = value => typeof value === 'string' ? value : value?._serialized || value?.$1
      const lid = wid.server === 'lid' ? id : stringify(alt)
      const pn = wid.server === 'lid' ? stringify(alt) : id
      const row = {id,lid,pn}
      rows.push(row)
      const contact = contacts.get(wid) || (alt && contacts.get(alt)) || await contacts.find(wid)
      if (contact) {
        row.name = getters.getName(contact)
        row.pushname = getters.getPushname(contact)
        row.verified = contact.verifiedName
      }
    } catch { /* The contact store may still be synchronizing. */ }
  }))
  let timer
  try {
    await Promise.race([pending,new Promise(resolve => {timer = setTimeout(resolve,650)})])
    return rows
  } finally { clearTimeout(timer) }
}

module.exports = {peerId,contactKey,displayName,aliasNames,messageSender,messageAuthor,senderNamesForRule,readAuthorContacts}
