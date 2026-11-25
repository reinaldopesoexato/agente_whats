const fs = require('node:fs/promises')
const { basename, isAbsolute, join, relative } = require('node:path')
const { createHash } = require('node:crypto')
const { spawn, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { pipeline } = require('node:stream/promises')

const runFile = promisify(execFile)

async function findFiles(root, query, limit) {
  const directory = await fs.realpath(root)
  const term = query.toLocaleLowerCase('pt-BR')
  const pending = [directory]
  const files = []
  let scanned = 0
  while (pending.length && files.length < limit && scanned < 50000) {
    const folder = pending.pop()
    const entries = await fs.opendir(folder)
    for await (const entry of entries) {
      if (++scanned > 50000) break
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      const path = join(folder, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else if (entry.isFile() && entry.name.toLocaleLowerCase('pt-BR').includes(term)) {
        const { size, mtime } = await fs.stat(path)
        files.push({ path, size, modifiedAt: mtime.toISOString() })
        if (files.length >= limit) break
      }
    }
  }
  return { root: directory, files, limited: files.length >= limit || scanned >= 50000 }
}

async function openLocal(root, input) {
  const directory = await fs.realpath(root)
  const path = await fs.realpath(isAbsolute(input) ? input : join(directory, input))
  const location = relative(directory, path)
  if (location === '..' || /^\.\.[/\\]/.test(location) || isAbsolute(location)) throw new Error('O caminho está fora da pasta informada.')
  if (process.platform === 'darwin') await runFile('open', [path])
  else if (process.platform === 'linux') await runFile('xdg-open', [path])
  else throw new Error('A abertura local pela CLI está disponível em macOS e Linux.')
  return { path }
}

async function exportAttachments({ manifest, destination, dryRun, download }) {
  const folder = await fs.realpath(destination)
  const files = []
  for (const item of manifest.messages) {
    const digest = createHash('sha256').update(JSON.stringify([item.account, item.id])).digest('hex').slice(0, 20)
    const filename = item.filename ? basename(item.filename.replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._-]/gu, '_').slice(-120) : ''
    const path = join(folder, digest + (filename ? '-' + filename : '.bin'))
    const entry = { ...item, path, status: 'planned' }
    files.push(entry)
    if (dryRun) continue
    let owned = false
    try {
      const handle = await fs.open(path, 'wx')
      owned = true
      try {
        const body = await download(item)
        await pipeline(body, handle.createWriteStream())
      } finally {
        await handle.close()
      }
      entry.status = 'saved'
    } catch (error) {
      if (owned) await fs.unlink(path)
      entry.status = !owned && error.code === 'EEXIST' ? 'exists' : 'error'
      if (entry.status === 'error') entry.error = error.message
    }
  }
  return { ...manifest, messages: files, destination: folder, dryRun }
}

async function prepareRoutine(config, name, args) {
  const recipes = JSON.parse(await fs.readFile(config, 'utf8'))
  const recipe = Object.hasOwn(recipes, name) ? recipes[name] : null
  if (!recipe || typeof recipe.program !== 'string' || !isAbsolute(recipe.program) ||
      typeof recipe.cwd !== 'string' || !isAbsolute(recipe.cwd) ||
      !Array.isArray(recipe.args) || recipe.args.some(arg => typeof arg !== 'string')) {
    throw new Error('Cadastre a rotina com executável, pasta e argumentos fixos no arquivo de configuração.')
  }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string') ||
      !Array.isArray(recipe.allowedArguments ?? []) || args.some(arg => !(recipe.allowedArguments ?? []).includes(arg))) {
    throw new Error('Argumento fora da lista da rotina.')
  }
  return { name, program: recipe.program, cwd: recipe.cwd, args: [...recipe.args, ...args] }
}

async function runPreparedRoutine(plan, env) {
  const { stdout, stderr } = await runFile(plan.program, plan.args,
    { cwd: plan.cwd, env, timeout: 120000, maxBuffer: 1024 * 1024 })
  return { name: plan.name, stdout, stderr }
}

async function runRoutine(config, name, args, dryRun) {
  const plan = await prepareRoutine(config, name, args)
  return dryRun ? { ...plan, dryRun } : runPreparedRoutine(plan)
}

async function service(action, label) {
  if (process.platform !== 'darwin') throw new Error('O gerenciamento pelo launchd está disponível no macOS.')
  if (!/^[a-zA-Z0-9._-]+$/.test(label)) throw new Error('Nome de serviço inválido.')
  const target = 'gui/' + process.getuid() + '/' + label
  try {
    const { stdout } = await runFile('/bin/launchctl', ['print', target])
    const running = /^\s*pid = \d+$/m.test(stdout)
    if (action === 'status') return { label, registered: true, running }
    if (running) await runFile('/bin/launchctl', ['stop', label])
  } catch (error) {
    if (action === 'status' && error.code === 113) return { label, registered: false, running: false }
    throw error
  }
  // launchctl stop delivers SIGTERM, so wait for the server to finish its shutdown.
  for (let attempt = 0; attempt < 60; attempt++) {
    const { stdout } = await runFile('/bin/launchctl', ['print', target])
    if (!/^\s*pid = \d+$/m.test(stdout)) {
      await runFile('/bin/launchctl', ['start', label])
      return { label, restartRequested: true }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('O serviço não encerrou no prazo esperado.')
}

async function serviceLogs(path, follow, emit) {
  const file = await fs.realpath(path)
  const child = spawn('tail', [...(follow ? ['-F'] : []), '-n', '60', file])
  const input = require('node:readline').createInterface({ input: child.stdout })
  input.on('line', line => emit({ line }))
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Não foi possível ler o log.')))
  })
}

async function notifyJob(job) {
  const message = 'Histórico · ' + job.status + ' · ' + job.completed + '/' + job.total + ' conversas'
  if (process.platform === 'darwin') {
    await runFile('/usr/bin/osascript', ['-e', 'on run argv', '-e',
      'display notification (item 1 of argv) with title "WhatsIA"', '-e', 'end run', message])
  } else if (process.platform === 'linux') await runFile('notify-send', ['WhatsIA', message])
  else throw new Error('Notificações disponíveis em macOS e Linux.')
}

async function scheduleRoutine({ config, name, args, weekday, time, destination, log, dryRun }) {
  if (!/^[a-zA-Z0-9_-]{1,60}$/.test(name) || !Number.isInteger(weekday) || weekday < 0 || weekday > 6 ||
      !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Informe nome simples, dia de 0 a 6 e hora HH:MM.')
  }
  const { resolve } = require('node:path')
  const configPath = await fs.realpath(config)
  await runRoutine(configPath, name, args, true)
  const logPath = resolve(log)
  const label = 'local.agente-whats.routine.' + name
  const argv = [process.execPath, join(__dirname, 'cli.js'), 'routine', '--config', configPath,
    '--name', name, '--arguments', JSON.stringify(args)]
  const [hour, minute] = time.split(':').map(Number)
  const xml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const string = value => '<string>' + xml(value) + '</string>'
  const plist = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<plist version="1.0"><dict>\n<key>Label</key>' + string(label) +
    '\n<key>ProgramArguments</key><array>' + argv.map(string).join('') + '</array>' +
    '\n<key>StartCalendarInterval</key><dict><key>Weekday</key><integer>' + weekday +
    '</integer><key>Hour</key><integer>' + hour + '</integer><key>Minute</key><integer>' + minute + '</integer></dict>' +
    '\n<key>StandardOutPath</key>' + string(logPath) + '\n<key>StandardErrorPath</key>' + string(logPath) +
    '\n</dict></plist>\n'
  if (!dryRun) await fs.writeFile(destination, plist, { flag: 'wx', mode: 0o600 })
  return { label, weekday, time, destination: resolve(destination), log: logPath, dryRun }
}

module.exports = { prepareRoutine, runPreparedRoutine, notifyJob, scheduleRoutine, exportAttachments, findFiles, openLocal, runRoutine, service, serviceLogs }
