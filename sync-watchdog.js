function createSyncWatchdog(timeout, now = Date.now) {
  const startedAt = now()
  let progressAt = startedAt
  let peak = -1
  let finishingAt = null

  function finishing() {
    finishingAt ??= now()
  }

  return {
    progress(percent) {
      if (!Number.isFinite(percent) || percent < 0 || percent > 100 || percent <= peak) return false
      peak = percent
      progressAt = now()
      return true
    },
    finishing,
    finalizationStalled() {
      return finishingAt !== null && now() - Math.max(progressAt, finishingAt) >= Math.min(timeout / 2, 90000)
    },
    failure() {
      const time = now()
      if (finishingAt !== null && time - Math.max(finishingAt, progressAt) >= timeout) {
        return 'O WhatsApp ficou preso na etapa final da sincronização. O Agente vai reconectar usando o perfil salvo.'
      }
      if ((finishingAt === null && time - progressAt >= timeout) || time - startedAt >= 2 * timeout) {
        return 'A sincronização do WhatsApp excedeu o tempo limite. O Agente vai reconectar usando o perfil salvo.'
      }
      return null
    }
  }
}

function guardSyncFinalization(page, onFailure) {
  const expose = page.exposeFunction.bind(page)
  let document = 0
  let finalization
  page.on('framenavigated', frame => {
    if (frame !== page.mainFrame()) return
    document++
    finalization = undefined
  })
  page.exposeFunction = (name, callback) => {
    if (name !== 'onAppStateHasSyncedEvent') return expose(name, callback)
    return expose(name, (...args) => {
      if (!finalization) {
        const currentDocument = document
        finalization = Promise.resolve().then(() => callback(...args)).catch(error => {
          if (document === currentDocument) onFailure(error)
        })
      }
      return finalization
    })
  }
}

module.exports = { createSyncWatchdog, guardSyncFinalization }
