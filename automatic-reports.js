// Treat a structured equipment receipt as evidence even when the model misses its template.
const fold = text => String(text || '').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase()
const reportHeader = /^\s*(?:\*?peso exato\*?\s+)?[*\[]*(?:relat[oó]rio (?:de )?balan[çc]a|envio (?:de |do )?relat[oó]rio)\b[^\r\n]*/i

function reportEvidence(record) {
  const body = record?.body
  if (typeof body !== 'string') return
  const heading = body.match(reportHeader)?.[0].trim()
  if (!heading || !/\bpdf\s*:\s*https?:\/\//i.test(body) ||
      !/\bcsv(?:_aves)?\s*:\s*https?:\/\//i.test(body)) return
  return heading.split(/\r?\n/).filter(Boolean).at(-1).trim().slice(0,180)
}

function deliveryEvent(item) {
  const topic = fold(item.topic)
  const text = topic+' '+fold(item.detail)
  return /\b(?:relatorio|pdf|csv(?:_aves)?)\b/.test(text) &&
    (/^(?:(?:confirmacao|sucesso|falha) (?:d[eo]|no) )?(?:envio|transmissao|encaminhamento)\b/.test(topic) ||
     /^(?:relatorio|pdf|csv(?:_aves)?)\b.*\b(?:enviado|encaminhado|transmitido)/.test(topic))
}

function ruleMatch(prompt, heading, group) {
  const text = fold(prompt).trim().replace(/[“”]/g,'"')
  // Only enforce positive, unconditional clauses. Let the normal classifier handle qualifications.
  if (/\b(?:nao|exceto|exclu\w*|ignor\w*|salvo|somente|apenas|desde que|se|quando|mas|sem|tirando|excecao|unicamente)\b/.test(text)) return
  const clauses = text.split(/\s+ou\s+|[,;\n]/).map(c=>c.trim().replace(/[.!]+$/,''))
  const allAutomatic = /^(?:(?:agrupe|inclua|classifique) (?:as )?)?(?:(?:todas as |quaisquer )?mensagens automaticas|qualquer mensagem (?:que (?:pareca|seja) )?automatica)$/
  const reportExample = /^(?:(?:agrupe|inclua|classifique) mensagens automaticas (?:do tipo|como) )?["']envio (?:de |do )?relatorio[.…]*["']$/
  if (heading && clauses.some(c=>allAutomatic.test(c) || reportExample.test(c))) {
    return {source:'atual',quote:heading,reason:'O aviso contém um cabeçalho de relatório de equipamento e links rotulados para PDF e CSV.'}
  }
  if (group && clauses.some(c=>{
    const match=/^(?:(?:todas )?as (?:mensagens )?do grupo|(?:inclua|agrupe) (?:todas )?as mensagens do grupo) ["']([^"']+)["'](?: sao automaticas)?(?: tambem)?$/.exec(c)
    return match && match[1]===fold(group).trim()
  })) return {source:'conversa',quote:group,reason:'A regra inclui expressamente as mensagens deste grupo.'}
}

// Reconcile the affected, already processed cards locally. Explicit moves and removals take precedence.
function repairExisting(state) {
  const rules=(state.todayCategories || []).filter(c=>c.prompt)
  if (!rules.length) return 0
  const key = (account,id)=>JSON.stringify([account,id])
  const protectedSources=new Set()
  for (const event of state.intelligence?.events || []) {
    if (event.corrected || state.todayCardPlaces?.[JSON.stringify(['decision',event.account,event.id])] !== undefined) {
      protectedSources.add(key(event.account,event.source))
    }
  }
  for (const row of state.revokedMessages || []) {
    for (const id of [row.id,...(row.aliases || [])]) protectedSources.add(key(row.account,id))
  }
  const accounts=new Map(state.accounts.map(a=>[a.id,a]))
  let changed=0
  for (const m of state.messages) {
    if (m.status!=='done' || !m.liveReceivedAt || m.todayLearned || m.todaySupplement ||
        state.todayCardPlaces?.[JSON.stringify(['message',m.account,m.id])] || protectedSources.has(key(m.account,m.id))) continue
    const heading=reportEvidence(m)
    if (!heading) continue
    const group = m.chat.endsWith('@g.us') && (accounts.get(m.account)?.chatNames?.[m.chat] ||
      state.conversationContexts?.[key(m.account,m.chat)]?.title || state.groupProfiles?.[m.chat]?.name)
    for (const rule of rules) {
      const evidence=ruleMatch(rule.prompt,heading,group)
      if (!evidence || m.todayCategoryIds?.includes(rule.id)) continue
      m.todayCategoryIds=[...(m.todayCategoryIds || []),rule.id]
      m.todayCategoryEvidence={...m.todayCategoryEvidence,[rule.id]:evidence}
      changed++
    }
  }
  return changed
}

module.exports={reportEvidence,deliveryEvent,ruleMatch,repairExisting}
