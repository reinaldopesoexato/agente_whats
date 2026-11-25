const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')

const file = path.join(__dirname, 'data', 'ai-settings.json')
const env = process.env
const defaults = {
  chatProvider: env.WHATSIA_TENANT === '1' ? 'cloud' : 'auto', ownerNames: env.OWNER_NAMES || (env.WHATSIA_TENANT ? 'dono da conta' : 'Reinaldo'),
  summaryTime: env.SUMMARY_TIME || '17:30', summaryZone: env.SUMMARY_TZ || 'America/Sao_Paulo',
  chatLocalModel: env.OLLAMA_MODEL || 'qwen3-vl:8b',
  chatCloudModel: env.OPENAI_MODEL || 'gpt-6-luna',
  autoLocalModel: env.OLLAMA_MODEL || 'qwen3-vl:8b',
  autoCloudModel: env.OPENAI_MODEL || 'gpt-6-luna',
  chatTokens: 2500, autoTokens: 2500, chatTimeout: 120,
  visionLocalModel: '', visionCloudModel: '',
  imageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-2.5-flare',
  imageQuality: 'medium', imageSize: '1024x1024',
  whisperModel: env.WHISPER_MODEL || '', ocrLanguages: env.TESSERACT_LANG || 'por+eng'
}
let saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
function sharedDefaults() {
  if (!env.WHATSIA_BROKER_URL) return {}
  const location = '/etc/whatsia/defaults'
  let models = {}
  try { models = JSON.parse(fs.readFileSync(path.join(location, 'shared.json'), 'utf8')) } catch {}
  if (!models.visionLocalModel && !saved.visionLocalModel &&
      (saved.autoLocalModel || models.autoLocalModel || defaults.autoLocalModel) === 'qwen3-vl:8b') {
    try { models.visionLocalModel = fs.readFileSync(path.join(location, 'ollama-vision-model'), 'utf8').trim() } catch {}
  }
  return models
}
function settings() {
  const {sharedKey,...models} = sharedDefaults()
  const personal = env.WHATSIA_TENANT ? saved.apiKey || env.OPENAI_API_KEY : saved.apiKey ?? env.OPENAI_API_KEY
  const whisperModel = env.WHATSIA_TENANT === '1' && env.WHISPER_MODEL &&
    (!saved.whisperModel || !fs.existsSync(saved.whisperModel)) ? env.WHISPER_MODEL : saved.whisperModel ?? defaults.whisperModel
  return {...defaults,...models,...saved,whisperModel,apiKey:personal || (sharedKey ? env.WHATSIA_BROKER_TOKEN : ''),
    managedModels:Boolean(env.WHATSIA_TENANT),useBroker:Boolean(!personal && sharedKey)}
}
function publicSettings() {
  const { apiKey, ...options } = settings()
  return { ...options, hasApiKey: Boolean(apiKey) }
}

function validate(key, value) {
  if (key === 'chatProvider') return ['auto', 'local', 'cloud'].includes(value)
  if (key === 'imageSize') return ['auto', '1024x1024', '1536x1024', '1024x1536'].includes(value)
  if (key === 'imageQuality') return ['auto', 'low', 'medium', 'high'].includes(value)
  if (key === 'chatTimeout') return Number.isInteger(value) && value >= 5 && value <= 600
  if (key.endsWith('Tokens')) return Number.isInteger(value) && value >= 64 && value <= 65536
  if (typeof value !== 'string' || /[\x00-\x1f\x7f]/.test(value)) return false
  if (key === 'ownerNames') return value.length > 0 && value.length <= 160
  if (key === 'summaryTime') return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value)
  if (key === 'summaryZone') {
    if (!value || value.length > 100) return false
    try { new Intl.DateTimeFormat('pt-BR', { timeZone: value }); return true }
    catch { return false }
  }
  if (key === 'apiKey') return value.length <= 1024 && !/\s/.test(value)
  if (key === 'whisperModel') return value.length <= 1024
  if (key === 'ocrLanguages') return /^[a-zA-Z0-9_]+(?:\+[a-zA-Z0-9_]+)*$/.test(value) && value.length <= 100
  return (key.startsWith('vision') && !value) || /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199}$/.test(value)
}

function saveSettings(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) throw new TypeError('Configurações inválidas.')
  const next = { ...saved }
  for (const [key, raw] of Object.entries(updates)) {
    if(env.WHATSIA_TENANT && raw===null && Object.hasOwn(defaults,key) && key.endsWith('Model') && key!=='whisperModel') {
      delete next[key]
      continue
    }
    const value = typeof raw === 'string' ? raw.trim() : raw
    if ((!Object.hasOwn(defaults, key) && key !== 'apiKey') || !validate(key, value)) throw new TypeError('Confira os campos das configurações de IA.')
    next[key] = value
  }
  const tmp = file + '.' + randomUUID()
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  try {
    fs.writeFileSync(tmp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
    fs.renameSync(tmp, file)
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  saved = next
  return publicSettings()
}

module.exports = { settings, publicSettings, saveSettings }
