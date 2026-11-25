const normalize = value => value.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase()
const words = value => normalize(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

function isBrasiliaTimeSkill(skill) {
  const description = words(skill.description || '')
  return !skill.builtin && /\b(?:hora|horas|horario)\b/.test(description) &&
    /\b(?:brasilia|america sao paulo)\b/.test(description) && /\b(?:api|relogio)\b/.test(description)
}

function asksBrasiliaTime(prompt) {
  const text = words(prompt)
  return /^(?:(?:por favor|me diga|me informe|consulte) )?(?:que horas (?:sao|e)|qual (?:e )?(?:a hora|o horario)(?: atual)?|(?:a )?hora atual|(?:o )?horario(?: atual)?)(?: (?:em brasilia|de brasilia|agora)){0,2}(?: por favor)?$/.test(text)
}

async function brasiliaTime(request = fetch) {
  const zone = 'America/Sao_Paulo'
  try {
    const response = await request('https://timeapi.io/api/Time/current/zone?timeZone=America%2FSao_Paulo',
      { signal: AbortSignal.timeout(3000), redirect: 'error' })
    if (!response.ok) throw new Error('Hora indisponível')
    const { timeZone, dateTime } = await response.json()
    const date = typeof dateTime === 'string' && /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)/.exec(dateTime)
    if (timeZone !== zone || !date) throw new Error('Hora inválida')
    const [, year, month, day, hours, minutes, seconds] = date
    return `Agora são ${hours}:${minutes}:${seconds} em Brasília, em ${day}/${month}/${year}. Fonte: TimeAPI.io.`
  } catch {
    const time = new Intl.DateTimeFormat('pt-BR', { timeZone: zone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date())
    return 'Horário de Brasília: ' + time + '. Fonte: relógio do computador (API indisponível).'
  }
}

function exactReplyRule(description) {
  if (typeof description !== 'string') return null
  const match = /^quando (?:eu )?receber (?:uma )?(?:mensagem )?exatamente\s+(?:"([^"]+)"|“([^”]+)”|'([^']+)')\s*,?\s+responda com\s+([\s\S]+)$/i.exec(description.trim())
  if (!match) return null
  const trigger = match[1] ?? match[2] ?? match[3]
  const literal = /^(?:"([^"]+)"|“([^”]+)”|'([^']+)')\s*\.?$/.exec(match[4])
  if (literal) return { trigger, text: literal[1] ?? literal[2] ?? literal[3] }
  const weather = /^a previs[aã]o do tempo (?:de|em|para)\s+([^\n]+?)\.?$/i.exec(match[4])
  if (!weather) return null
  const parts = weather[1].split(/\s*[,–—]\s*|\s+-\s+/)
  if (parts.length > 2 || parts.some(part => !/^[\p{L}][\p{L}\p{M} .'-]*$/u.test(part) ||
      part.length > 80 || /\be (?:tamb[eé]m|depois)\b/i.test(part))) return null
  return { trigger, city: parts[0], region: parts[1] || '' }
}

async function readJson(base, parameters, request) {
  const url = new URL(base)
  url.search = new URLSearchParams(parameters)
  const response = await request(url, { signal: AbortSignal.timeout(8000), redirect: 'error' })
  if (!response.ok) throw new Error('A consulta de previsão retornou HTTP ' + response.status + '.')
  return response.json()
}

async function forecastFor({ city, region }, request = fetch) {
  const data = await readJson('https://geocoding-api.open-meteo.com/v1/search',
    { name: city, language: 'pt', count: '30', countryCode: 'BR' }, request)
  const matches = (data.results || []).filter(item => words(item.name || '') === words(city) &&
    (!region || words(item.admin1 || '') === words(region)) &&
    Number.isFinite(item.latitude) && Number.isFinite(item.longitude))
  const locations = new Map(matches.map(item => [words(item.admin1 || ''), item]))
  if (locations.size !== 1) throw new Error('Não foi possível identificar a cidade. Confira o nome e o estado na descrição.')
  const point = locations.values().next().value
  const { daily } = await readJson('https://api.open-meteo.com/v1/forecast', {
    latitude: point.latitude, longitude: point.longitude, timezone: 'auto', forecast_days: '1',
    daily: 'precipitation_probability_max,precipitation_sum,temperature_2m_min,temperature_2m_max'
  }, request)
  const date = daily?.time?.[0]
  const probability = daily?.precipitation_probability_max?.[0]
  const rain = daily?.precipitation_sum?.[0]
  const min = daily?.temperature_2m_min?.[0]
  const max = daily?.temperature_2m_max?.[0]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || ![probability, rain, min, max].every(Number.isFinite)) {
    throw new Error('O serviço retornou uma previsão incompleta.')
  }
  const number = value => value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })
  const place = [point.name, point.admin1].filter(Boolean).join(' – ')
  return `*Previsão para ${place} (${date.split('-').reverse().join('/')})*\n` +
    `Chance de chuva: ${number(probability)}%. Chuva prevista: ${number(rain)} mm.\n` +
    `Temperatura: ${number(min)} °C a ${number(max)} °C.\nFonte: Open-Meteo.`
}

module.exports = { exactReplyRule, forecastFor, isBrasiliaTimeSkill, asksBrasiliaTime, brasiliaTime }
