#!/usr/bin/env node
const { parseArgs } = require('node:util')
const { readFileSync } = require('node:fs')
const { loadEnvFile } = require('node:process')
const { join, basename } = require('node:path')
const { writeFile, stat } = require('node:fs/promises')
const { setTimeout: delay } = require('node:timers/promises')
const { sampleEvaluation, evaluateCases } = require('./evaluation')
const { exportAttachments, findFiles, openLocal, runRoutine, service, serviceLogs, notifyJob, scheduleRoutine } = require('./pc-tools')
const emit = result => console.log(JSON.stringify(result))

const commands = {
  status: 'status',
  evaluate: 'evaluate [--account ID --cases ARQUIVO_JSON] [--input-rate N --output-rate N]',
  accounts: 'accounts',
  'wa-actions': 'wa-actions',
  'wa-action': 'wa-action --account ID --name OPERACAO [--chat ID --source MENSAGEM --arguments JSON]',
  'wa-skill': 'wa-skill --account ID --id SKILL [--source MENSAGEM]',
  chats: 'chats --account ID',
  messages: 'messages --account ID --chat ID [--source ID]',
  context: 'context --account ID --chat ID',
  ask: 'ask --account ID [--chat ID] [--thread ID] [--prompt TEXTO | < prompt.txt]',
  register: 'register --consumer NOME [--account ID] [--chat ID] [--from now|stored]',
  check: 'check --consumer NOME',
  claim: 'claim --consumer NOME [--limit N] [--seconds N]',
  watch: 'watch --consumer NOME [--limit N] [--seconds N] [--once]',
  renew: 'renew --consumer NOME --lease ID [--seconds N]',
  ack: 'ack --consumer NOME --lease ID',
  release: 'release --consumer NOME --lease ID',
  draft: 'draft --account ID --chat ID [--source ID] [--text TEXTO | < resposta.txt]',
  approve: 'approve --id ID --confirm',
  history: 'history [--days N] [--group ID]',
  doctor: 'doctor',
  'link-file': 'link-file --id ID_DA_PENDENCIA --path ARQUIVO',
  pending: 'pending [--account ID] [--overdue]',
  jobs: 'jobs [--id ID] [--follow] [--notify]',
  cancel: 'cancel --id ID',
  retry: 'retry --id ID',
  pause: 'pause --id ID',
  resume: 'resume --id ID',
  'attachment-issues': 'attachment-issues',
  'attachment-retry': 'attachment-retry --account ID --source ID_DA_MENSAGEM',
  today: 'today [--account ID|all]',
  attachments: 'attachments --account ID --chat ID [--days N] [--limit N] [--destination PASTA] [--index ARQUIVO] [--dry-run]',
  files: 'files --root PASTA --query TEXTO [--limit N]',
  open: 'open --root PASTA --path CAMINHO',
  report: 'report --account ID --prompt TEXTO --destination ARQUIVO.md [--chat ID]',
  routine: 'routine --config ARQUIVO --name NOME [--arguments JSON] [--dry-run]',
  schedule: 'schedule --config ARQUIVO --name NOME --weekday 0-6 --time HH:MM --destination PLIST --log ARQUIVO [--arguments JSON] [--dry-run]',
  service: 'service --action status|restart|logs [--label NOME] [--path LOG] [--follow]'
}
const optionNames = ['input-rate', 'output-rate', 'cases', 'account', 'chat', 'source', 'thread', 'prompt', 'consumer', 'from', 'limit', 'seconds', 'lease', 'text', 'id', 'days', 'group', 'port', 'destination', 'root', 'query',
  'path', 'config', 'name', 'arguments', 'action', 'label', 'index', 'weekday', 'time', 'log']
const stringOptions = Object.fromEntries(optionNames.map(name => [name, { type: 'string' }]))

async function main() {
  const [command, ...args] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') return { version: 1, commands }
  if (!Object.hasOwn(commands, command)) throw new Error('Comando desconhecido. Use help.')
  const { values } = parseArgs({ args, options: { ...stringOptions, confirm: { type: 'boolean' }, once: { type: 'boolean' }, follow: { type: 'boolean' },
    overdue: { type: 'boolean' }, notify: { type: 'boolean' }, 'dry-run': { type: 'boolean' } } })
  const required = key => {
    if (!values[key]) throw new Error('Informe --' + key + '.')
    return values[key]
  }
  const input = key => {
    const value = values[key] ?? (!process.stdin.isTTY ? readFileSync(0, 'utf8') : '')
    if (!value.trim()) throw new Error('Informe --' + key + ' ou forneça texto pela entrada padrão.')
    return value
  }
  try { loadEnvFile(join(__dirname, '.env')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const port = Number(values.port || process.env.PORT || 3030)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Porta inválida.')
  const api = async (path, body, binary = false) => {
    const response = await fetch('http://127.0.0.1:' + port + '/api/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(150000)
    })
    if (binary && response.ok) return response.body
    const data = await response.json().catch(() => null)
    if (!response.ok) {
      const error = new Error(data?.error || 'Erro HTTP ' + response.status)
      error.status = response.status
      throw error
    }
    return data
  }
  const account = () => 'accounts/' + encodeURIComponent(required('account'))
  const chat = () => account() + '/chats/' + encodeURIComponent(required('chat'))
  if (command === 'evaluate') {
    const result = values.cases
      ? await evaluateCases(JSON.parse(readFileSync(values.cases, 'utf8')), test => api(account() + '/ai/ask',
        { prompt: test.prompt, chat: test.chat, scope: test.chat ? 'chat' : 'all', readOnly: true }))
      : { results: sampleEvaluation() }
    if (values['input-rate'] !== undefined || values['output-rate'] !== undefined) {
      const rates = [Number(values['input-rate'] ?? 0), Number(values['output-rate'] ?? 0)]
      if (rates.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Informe custos não negativos por milhão de tokens.')
      for (const test of result.results) {
        if (test.usage?.calls) test.estimatedCost = (test.usage.inputTokens * rates[0] + test.usage.outputTokens * rates[1]) / 1000000
      }
    }
    const passed = result.results.filter(test => test.pass).length
    if (passed < result.results.length) process.exitCode = 1
    return { passed, total: result.results.length, results: result.results }
  }
  if (command === 'doctor') return api('integration/doctor')
  if (command === 'files') {
    const limit = Number(values.limit ?? 50)
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Informe limite de 1 a 500.')
    return findFiles(required('root'), required('query'), limit)
  }
  if (command === 'open') return openLocal(required('root'), required('path'))
  if (command === 'routine') return runRoutine(required('config'), required('name'),
    JSON.parse(values.arguments || '[]'), Boolean(values['dry-run']))
  if (command === 'schedule') return scheduleRoutine({
    config: required('config'), name: required('name'), args: JSON.parse(values.arguments || '[]'),
    weekday: Number(required('weekday')), time: required('time'), destination: required('destination'),
    log: required('log'), dryRun: Boolean(values['dry-run'])
  })
  if (command === 'service') {
    const action = required('action')
    if (action === 'logs') return serviceLogs(required('path'), values.follow, emit)
    if (!['status', 'restart'].includes(action)) throw new Error('Ação de serviço desconhecida.')
    return service(action, values.label || 'local.agente-whats.codex')
  }
  if (command === 'link-file') {
    const file = required('path')
    const info = await stat(file)
    if (!info.isFile() || info.size < 1 || info.size > 5 * 1024 * 1024) throw new Error('Informe um arquivo de até 5 MiB.')
    return api('actions/' + encodeURIComponent(required('id')) + '/files',
      { name: basename(file), data: readFileSync(file).toString('base64') })
  }
  if (command === 'pending') {
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.SUMMARY_TZ || 'America/Sao_Paulo' }).format()
    const { actions } = await api('ai')
    return actions.filter(item => item.status === 'open' && (!values.account || item.account === values.account) &&
      (!values.overdue || (item.due && item.due < today)))
  }
  if (command === 'jobs') {
    for (;;) {
      const job = await api('history/bulk')
      if (values.id && job?.id !== values.id) throw new Error('Lote não encontrado.')
      if (!values.follow) return job
      emit(job)
      if (!['listing', 'processing', 'waiting'].includes(job?.status)) {
        if (values.notify && job) await notifyJob(job)
        return
      }
      await delay(2000)
    }
  }
  if (['pause', 'resume'].includes(command)) return api('history/bulk/control', { id: required('id'), action: command })
  if (['cancel', 'retry'].includes(command)) return api('history/bulk/' + command, { id: required('id') })
  if (command === 'today') return api(values.account ? 'today?account=' + encodeURIComponent(values.account) : 'today')
  if (command === 'attachment-issues') return api('attachments/issues')
  if (command === 'attachment-retry') return api(account() + '/attachments/' + encodeURIComponent(required('source')) + '/retry', {})
  if (command === 'attachments') {
    const query = new URLSearchParams({ days: values.days ?? '7', limit: values.limit ?? '100' })
    const manifest = await api(chat() + '/attachments?' + query)
    const result = values.destination ? await exportAttachments({ manifest, destination: values.destination,
      dryRun: values['dry-run'], download: item => api(account() + '/media/' + encodeURIComponent(item.id), undefined, true) }) : manifest
    if (values.index && !values['dry-run']) await writeFile(values.index, JSON.stringify(result, null, 2) + '\n', { flag: 'wx' })
    return result
  }
  if (command === 'report') {
    const destination = required('destination')
    const result = await api(account() + '/ai/ask', { prompt: input('prompt'), readOnly: true,
      chat: values.chat, scope: values.chat ? 'chat' : 'all' })
    const sources = (result.sources || []).map(source => '- ' + JSON.stringify(source)).join('\n')
    await writeFile(destination, result.answer + (sources ? '\n\n## Fontes\n\n' + sources : '') + '\n', { flag: 'wx' })
    return { destination, entryId: result.entryId, sources: result.sources?.length || 0 }
  }
  if (['register', 'check', 'claim', 'ack', 'release', 'watch', 'renew'].includes(command)) {
    const payload = {
      action: command, consumer: required('consumer'), account: values.account, chat: values.chat, from: values.from,
      limit: values.limit === undefined ? undefined : Number(values.limit),
      seconds: values.seconds === undefined ? undefined : Number(values.seconds),
      lease: ['ack', 'release', 'renew'].includes(command) ? required('lease') : undefined
    }
    if (command !== 'watch') return api('integration/inbox', payload)
    for (;;) {
      const batch = await api('integration/inbox', payload)
      if (batch.messages.length) {
        if (values.once) return batch
        emit(batch)
      }
    }
  }
  if (command === 'accounts' || command === 'status') {
    const accounts = (await api('accounts')).map(({ id, name, mode, status, error }) => ({ id, name, mode, status, error }))
    return command === 'accounts' ? accounts : { accounts, analysis: await api('message-analysis'), history: await api('history/bulk') }
  }
  if (command === 'wa-actions') return api('whatsapp/actions')
  if (command === 'wa-action') {
    const params = JSON.parse(values.arguments || '{}')
    if (!params || Array.isArray(params) || typeof params !== 'object') throw new Error('Informe um objeto JSON em --arguments.')
    return api(account() + '/whatsapp/action', { operation: required('name'), chat: values.chat, message: values.source, params })
  }
  if (command === 'wa-skill') return api(account() + '/whatsapp/action', { skillId: required('id'), message: values.source })
  if (command === 'chats') return api(account() + '/chats')
  if (command === 'messages') return api(chat() + (values.source ? '?source=' + encodeURIComponent(values.source) : ''))
  if (command === 'context') return api(chat() + '/context')
  if (command === 'ask') return api(account() + '/ai/ask', { prompt: input('prompt'), thread: values.thread, readOnly: true,
    chat: values.chat, scope: values.chat ? 'chat' : 'all' })
  if (command === 'draft') return api(account() + '/integration/draft', {
    chat: required('chat'), source: values.source, text: input('text')
  })
  if (command === 'approve') {
    if (!values.confirm) throw new Error('Revise o rascunho e informe --confirm para autorizar o envio.')
    return api('ai/deliveries/' + encodeURIComponent(required('id')) + '/send', {})
  }
  return api('history/bulk', values.days === undefined ? undefined : { days: Number(values.days), group: values.group })
}

main().then(result => { if (result !== undefined) emit(result) }).catch(error => {
  console.error(JSON.stringify({ error: error.cause?.code === 'ECONNREFUSED' ? 'WhatsIA indisponível na porta local.' : error.message,
    ...(error.status ? { status: error.status } : {}) }))
  process.exitCode = 1
})
