const { performance } = require('node:perf_hooks')
const { normalize } = require('./live-query')
const { captureEvents, latestEvents, watchOutcome, needsClarification } = require('./intelligence')

function sampleEvaluation() {
  const data = { events: [] }
  const times = [10, 20, 30]
  const statements = ['Confirmada a instalação na terça-feira', 'Mudou a instalação para quinta-feira', 'A instalação foi cancelada']
  const statuses = ['confirmado', 'alterado', 'cancelado']
  const records = statements.map((body, index) => ({ id: String(index + 1), account: 'teste', chat: 'suporte', timestamp: times[index], body }))
  const events = statements.map((detail, index) => ({ source: String(index + 1), topic: 'Instalação', status: statuses[index], detail, quote: detail }))
  captureEvents(data, records, [...events, { ...events[0], quote: 'trecho não presente', status: 'concluido' }])
  const [decision] = latestEvents(data)
  const watch = { account: 'teste', chat: 'suporte', createdAt: 40, due: '2026-11-27', topic: 'orçamento instalação' }
  const replies = [{ ...records[0], timestamp: 41, body: 'Confirmei a entrega do catálogo' },
    { ...records[1], timestamp: 42, body: 'Confirmei o orçamento da instalação' }]
  return [
    { name: 'Mudança seguida de cancelamento', pass: decision?.status === 'cancelado' && decision.source === '3' },
    { name: 'Evidência inventada rejeitada', pass: data.events.length === 3 },
    { name: 'Resposta sobre outro assunto ignorada', pass: watchOutcome(watch, replies.slice(0, 1), '2026-11-28').status === 'atrasado' },
    { name: 'Resposta vinculada à origem', pass: watchOutcome(watch, replies, '2026-11-27').source === '2' },
    { name: 'Duas propostas pedem esclarecimento', pass: needsClarification('O cliente aprovou?', '', [{ topic: 'Instalação' }, { topic: 'Orçamento' }], false).length === 2 }
  ]
}

async function evaluateCases(cases, ask) {
  if (!Array.isArray(cases) || cases.length < 1 || cases.length > 100) throw new Error('Informe entre 1 e 100 casos.')
  const results = []
  for (const [index, test] of cases.entries()) {
    if (typeof test?.prompt !== 'string' || !test.prompt.trim()) throw new Error('Informe o prompt de cada caso.')
    if (test.contains != null && (!Array.isArray(test.contains) || test.contains.some(term => typeof term !== 'string'))) {
      throw new Error('O campo contains aceita uma lista de textos.')
    }
    if (test.sources != null && (!Array.isArray(test.sources) || test.sources.some(id => typeof id !== 'string'))) {
      throw new Error('O campo sources aceita uma lista de IDs de mensagens.')
    }
    if (!test.contains?.length && !test.sources?.length && typeof test.clarification !== 'boolean') {
      throw new Error('Cada caso precisa de pelo menos um resultado esperado.')
    }
    const start = performance.now()
    const name = typeof test.name === 'string' ? test.name : 'Caso ' + (index + 1)
    try {
      const result = await ask(test)
      const text = normalize(result.answer)
      const matched = (test.contains || []).every(term => text.includes(normalize(term)))
      const sources = (test.sources || []).every(id => result.sources?.some(source => source.source === id))
      const clarification = test.clarification === undefined || Boolean(result.needsClarification) === test.clarification
      results.push({ name, pass: matched && sources && clarification, matched, sources, clarification,
        milliseconds: Math.round(performance.now() - start), usage: result.usage || null })
    } catch (error) {
      results.push({ name, pass: false, milliseconds: Math.round(performance.now() - start), error: error.message })
    }
  }
  return { passed: results.filter(result => result.pass).length, total: results.length, results }
}

module.exports = { sampleEvaluation, evaluateCases }
