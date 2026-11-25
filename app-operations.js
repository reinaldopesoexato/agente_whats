const { historyCommand } = require('./history-skill')

function appOperation(prompt) {
  const text = prompt.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
    .replace(/^(?:por favor,?\s+|(?:voce\s+)?pode\s+)/, '')
    .replace(/\s*,?\s+por favor[.!?]*$/, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ')
  if (/^(?:(?:qual (?:e )?o |ver |mostre o )?status (?:do reprocessamento|do processamento em lote)|como (?:esta|vai) o reprocessamento)$/.test(text)) {
    return { action: 'bulkStatus' }
  }

  const restart = /^(?:reinicie|reiniciar)\s+(?:(?:todas\s+)?(?:as\s+)?(sessoes)(?:\s+do whatsapp)?|(?:a\s+)?sessao(?:\s+(?:atual|desta conta|da conta selecionada|do whatsapp))?)$/.exec(text)
  if (restart) return { action: 'restart', all: Boolean(restart[1]) }

  const bulk = /^(?:reprocesse|reprocessar)\s+(?:todas as conversas|todo o historico de todas as conversas|tudo)(?:\s+(.*))?$/.exec(text)
  if (!bulk) return null
  const periodText = (bulk[1] || '').replace(/^de\s+(?=\d+\s+dias\b)/, '')
  const history = historyCommand('reprocesse ' + periodText)
  if (!history?.period?.days || history.target) return { action: 'bulkHelp' }
  return { action: 'bulk', days: history.period.days }
}

module.exports = { appOperation }
