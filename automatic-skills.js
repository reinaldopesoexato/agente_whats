const { createHash } = require('node:crypto')

const actions = new Set(['task', 'draft', 'send', 'webhook'])
const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex')
const text = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : ''
const generatesReply = rule => rule.action === 'send' && rule.replyMode === 'generated'
const descriptionWords = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function mentionedInDescription(description, value) {
  const phrase = descriptionWords(value)
  return Boolean(phrase && (' ' + descriptionWords(description) + ' ').includes(' ' + phrase + ' '))
}

function eligibleRule(rule, message, author, directPerson) {
  return Boolean(rule?.enabled && !message.fromMe && message.liveReceivedAt >= rule.since &&
    (!rule.account || rule.account === message.account) && (!rule.group || rule.group === message.chat) &&
    (!rule.person || rule.person === author) &&
    (!['send', 'draft'].includes(rule.action) || rule.group ||
      (rule.person ? rule.person === directPerson : generatesReply(rule))))
}

function eventDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return ''
  const date = new Date(value + 'T00:00:00Z')
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : ''
}

function createRun(skill, message, decision, labels, today) {
  const rule = skill.automation
  if (!['match', 'review'].includes(decision?.outcome) || decision?.alreadyDone === true) return null
  const generated = generatesReply(rule)
  const reply = generated && typeof decision.text === 'string' ? decision.text.trim() : ''
  const tooLong = reply.length > 4000
  const body = generated ? (tooLong ? '' : reply) :
    rule.action === 'send' ? rule.replyText : text(decision.text, 1000)
  const reason = tooLong ? 'A resposta gerada excede 4000 caracteres.' : text(decision.reason, 300)
  const date = rule.oncePerDate ? eventDate(decision.eventDate) : ''
  if (date && date < today && ['send', 'draft'].includes(rule.action)) return null
  const ready = decision.outcome === 'match' && body && (!rule.oncePerDate || date)
  const status = !ready || rule.action === 'draft' ? 'review' : rule.action === 'task' ? 'done' : 'queued'
  return {
    id: digest([skill.id, message.account, message.chat, message.id]),
    event: ready && date ? digest([skill.id, rule.group || rule.person || message.chat, date]) : null,
    skill: skill.id, skillName: skill.name, revision: rule.revision,
    account: message.account, chat: message.chat, source: message.id, sender: message.sender,
    ...labels, action: rule.action, status, body: ready ? body : '', reason,
    due: eventDate(decision.due) || null, date: date || null, created: Date.now()
  }
}

function duplicateRun(runs, run) {
  return runs.some(item => item.id === run.id || (run.event && item.event === run.event && item.status !== 'canceled'))
}

function createDescriptionRun(skill, message, decision, labels, today, findDestination) {
  if (!['match', 'review'].includes(decision?.outcome) || decision.alreadyDone === true) return null
  const action = decision.action
  if (!actions.has(action) || !mentionedInDescription(skill.description, decision.instruction)) return null
  const whatsapp = action === 'send' || action === 'draft'
  const body = typeof decision.text === 'string' ? decision.text.trim() : ''
  const date = decision.oncePerDate === true ? eventDate(decision.eventDate) : ''
  if (date && date < today && whatsapp) return null
  let reason = text(decision.reason, 300)
  let destination
  if (whatsapp && decision.outcome === 'match') {
    try {
      destination = findDestination(decision)
    } catch (error) {
      reason = error.message
    }
  }
  if (body.length > 4000) reason = 'A resposta excede 4000 caracteres.'
  const ready = decision.outcome === 'match' && body && body.length <= 4000 &&
    (decision.oncePerDate !== true || date) && (!whatsapp || destination)
  const target = destination && [destination.account, destination.chat]
  return {
    id: digest([skill.id, message.account, message.chat, message.id, action, target || null,
      action === 'task' ? descriptionWords(decision.instruction) : null]),
    event: ready && date ? digest([skill.id, message.chat, action, destination?.chat || null, date]) : null,
    skill: skill.id, skillName: skill.name, revision: skill.revision,
    account: message.account, chat: message.chat, source: message.id, sender: message.sender,
    ...labels, action, status: !ready || action === 'draft' ? 'review' : action === 'task' ? 'done' : 'queued',
    body: ready ? body : '', reason, destination,
    due: eventDate(decision.due) || null, date: date || null, created: Date.now()
  }
}

module.exports = { eligibleRule, createRun, duplicateRun, createDescriptionRun, mentionedInDescription }
