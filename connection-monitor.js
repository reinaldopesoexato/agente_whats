function withTimeout(task, milliseconds, message) {
  let timer
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

function createConnectionMonitor({ accounts, sessions, restart, stopped, now = Date.now,
  timeout = 8000, baseDelay = 2500, maxDelay = 120000, onError = console.error }) {
  const health = new Map()

  async function check(account) {
    const id = account.id
    if (stopped(id)) return
    let entry = health.get(id)
    if (!entry) {
      entry = { attempts: 0, failures: 0 }
      health.set(id, entry)
    }
    const session = sessions.get(id)
    if (!session || entry.checking || session.restarting) return
    if (entry.session !== session) {
      entry.session = session
      entry.failures = 0
      entry.healthy = 0
    }
    entry.checking = true
    try {
      if (session.status === 'Conectado') {
        const browser = session.client?.pupBrowser
        const page = session.client?.pupPage
        if (!browser?.isConnected() || !page || page.isClosed()) {
          session.disconnect('O Chromium ou a aba do WhatsApp fechou.')
        } else {
          let reason
          try {
            const status = await withTimeout(() => session.client.getState(), timeout, 'O Chromium não respondeu à verificação.')
            if (status !== 'CONNECTED') reason = 'Conexão do WhatsApp instável (' + (status || 'estado indisponível') + ').'
          } catch (error) {
            reason = error.message
          }
          if (stopped(id) || sessions.get(id) !== session || session.status !== 'Conectado') return
          if (!reason) {
            entry.failures = 0
            if (++entry.healthy >= 2) entry.attempts = 0
          } else {
            entry.healthy = 0
            if (++entry.failures >= 2) session.disconnect(reason)
          }
        }
      }
      if (stopped(id) || sessions.get(id) !== session || session.restarting || session.status !== 'Desconectado') return
      if (!session.retryAt) {
        session.retryAt = now() + Math.min(maxDelay, baseDelay * 2 ** Math.min(entry.attempts, 10))
        return
      }
      if (session.retryAt > now()) return
      entry.attempts++
      delete session.retryAt
      await restart(account, session, false)
    } catch (error) {
      onError(error)
    } finally {
      entry.checking = false
    }
  }

  return () => Promise.allSettled(accounts().map(check))
}

module.exports = { createConnectionMonitor, withTimeout }
