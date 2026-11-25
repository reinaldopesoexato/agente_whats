const HISTORY_SKILL_NAME = 'Reprocessar histórico de conversa'
const HISTORY_SKILL_DESCRIPTION = 'Ao pedir para reprocessar o histórico de uma conversa individual ou grupo, use a conversa selecionada ou o nome informado. Aceite os últimos N dias, um intervalo de datas ou todo o histórico. Informe o início e o progresso. Se eu mandar parar ou cancelar, interrompa o trabalho e preserve os lotes concluídos.'
const isHistorySkill = skill => skill?.name === HISTORY_SKILL_NAME && !skill.builtin

function isoDate(value) {
  const date = value.includes('/') ? value.split('/').reverse().join('-') : value
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const time = new Date(date + 'T00:00:00Z')
  return Number.isFinite(time.getTime()) && time.toISOString().slice(0, 10) === date ? date : null
}

function historyCommand(prompt, explicit = false) {
  const text = prompt.trim()
  const stop = /^(?:\/parar|parar|pare|cancele|cancelar)(?:\s+(?:(?:o\s+)?(?:reprocessamento|processamento|hist[oó]rico)|de reprocessar))?(?:\s+([a-f\d-]{36}))?[.!]?$/i.exec(text)
  if (stop) return { action: 'stop', id: stop[1] }
  const command = /^(?:reprocessar|reprocesse)\b/i.exec(text)
  if (!command && !explicit) return null
  const details = text.slice(command?.[0].length || 0).trim().replace(/[.!?]+$/, '')
  const request = /^todo o hist[oó]rico\b/i.test(details) ? details : details
    .replace(/^(?:(?:o\s+)?hist[oó]rico|as mensagens)\b\s*(?:(?:de|do|da)\s+)?/i, '')
  const findPeriod = pattern => [...request.matchAll(pattern)].find(match =>
    match.index === 0 || match.index + match[0].length === request.length)
  const relative = findPeriod(/(?:^|\s+)(?:(?:os|dos|nos)\s+)?(?:[úu]ltimos\s+)?(\d+)\s+dias\b/gi)
  const week = findPeriod(/(?:^|\s+)(?:(?:da|na|a)\s+)?[úu]ltima\s+semana\b/gi)
  const range = findPeriod(/(?:^|\s+)(?:de\s+)?(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})\s+(?:a|at[eé])\s+(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})\b/gi)
  const all = findPeriod(/(?:^|\s+)(?:todo o hist[oó]rico|desde o in[ií]cio)\b/gi)
  let period
  const match = relative || week || range || all
  if (relative) {
    const days = Number(relative[1])
    if (days >= 1 && days <= 3650) period = { days }
  } else if (week) {
    period = { days: 7 }
  } else if (range) {
    const start = isoDate(range[1]), end = isoDate(range[2])
    if (start && end && start <= end) period = { start, end }
  } else if (all) period = { days: null }
  if (!period) return { action: 'help' }
  let target = (request.slice(0, match.index) || request.slice(match[0].length)).trim()
    .replace(/^(?:(?:de|da|do)\s+)?(?:(?:o\s+)?hist[oó]rico\b\s*(?:de|do|da)?\s*)?/i, '')
    .replace(/^(?:(?:a\s+)?conversa\s+(?:com\s+)?|(?:o\s+)?grupo\s+|com\s+)/i, '')
    .replace(/^["“]|["”]$/g, '').trim()
  if (/^(?:aqui|este chat|este grupo|a conversa|esta conversa|neste chat|neste grupo|nesta conversa)$/i.test(target)) target = ''
  return { action: 'start', target, period }
}

const historyActive = job => ['loading', 'analyzing', 'stopping'].includes(job?.status)

module.exports = { HISTORY_SKILL_NAME, HISTORY_SKILL_DESCRIPTION, isHistorySkill, historyCommand, historyActive }
