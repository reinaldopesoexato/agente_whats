const {createHash}=require('node:crypto')

function eligible(record,account,state) {
  return account && !record.fromMe && record.liveReceivedAt && record.status==='done' && account.mode!=='off' &&
    !(account.mode==='cloud' && record.queuedMode==='local') && !state.revokedMessages.some(m=>
      m.account===record.account && m.chat===record.chat && (m.id===record.id||m.aliases?.includes(record.id)))
}
function eventFor(state,record,account,title,author) {
  const text=m=>[m.body,m.transcript||m.extracted||m.caption].filter(x=>typeof x==='string'&&x.trim())
    .map(x=>x.replace(/[A-Za-z0-9+/=]{90,}/g,' ').trim()).filter(Boolean)
  const revoked=new Set(state.revokedMessages.filter(m=>m.account===account.id && m.chat===record.chat).flatMap(m=>[m.id,...(m.aliases||[])]))
  const history=[]
  for(let i=state.messages.lastIndexOf(record)-1;i>=0 && history.length<8;i--) {
    const m=state.messages[i]
    if(m.account!==account.id || m.chat!==record.chat || m.timestamp>record.timestamp || revoked.has(m.id) ||
      ['ignored','revoked'].includes(m.status)||m.type==='revoked'|| (account.mode==='cloud'&&m.queuedMode==='local'))continue
    const message=text(m).join('\n').slice(0,650)
    if(message)history.push({sender:author(m),text:message})

  }
  return {receivedAt:record.liveReceivedAt,account:account.id,accountName:account.name,chat:record.chat,title,
    message:record.id,cursor:record.managedCursor,sender:author(record),text:text({body:record.body})[0]?.slice(0,5000),
    attachment:text({transcript:record.transcript||record.extracted||record.caption})[0]?.slice(0,5000),history:history.reverse()}
}
function applyEffects(state,record,account,title,effects) {
  if(!Array.isArray(effects))throw Error('Resultado inválido.')
  const thread='contexto-'+createHash('sha256').update(JSON.stringify([account.id,record.chat])).digest('hex').slice(0,32)
  for(const effect of effects) {
    if(!/^[a-f0-9]{64}$/.test(effect?.id)||typeof effect.text!=='string'||!effect.text.trim())continue
    if(state.actions.some(a=>a.id===effect.id)||state.aiQueries.some(q=>q.id===effect.id))continue
    if(effect.action==='task') {
      state.actions.unshift({id:effect.id,account:account.id,chat:record.chat,source:record.id,sender:record.sender,
        status:'open',title:effect.text.slice(0,300),reason:'Identificada na mensagem de origem.'})
    } else if(effect.action==='draft'||effect.action==='summary') {
      const entry={id:effect.id,thread,scope:'chat',scopeLabel:title,account:account.id,chat:record.chat,timestamp:Date.now(),
        prompt:effect.action==='draft'?'Rascunho de resposta':'Resumo da mensagem',answer:effect.text.slice(0,4000)}
      if(effect.action==='draft') entry.delivery={account:account.id,accountName:account.name,chat:record.chat,recipient:title,
        quoted:record.id,quotePreview:(record.body||'').slice(0,400),body:entry.answer,status:'draft'}
      state.aiQueries.push(entry)
    }
  }
}
function startManagedMessages({state,settings,title,author,active,save}) {
  const url=process.env.WHATSIA_RULES_URL
  if(!url)return ()=>{}
  const pending=new Set(state.messages.filter(m=>m.managedPending))
  let busy=false
  const tick=async()=>{
    if(busy||!active())return
    let record
    for(const m of pending) {
      const a=state.accounts.find(item=>item.id===m.account)
      if(!a||!m.managedPending){pending.delete(m);continue}
      if(!(m.managedRetryAt>Date.now()) && a.mode!=='off' && !(a.mode==='cloud'&&m.queuedMode==='local')){
        record=m;break
      }
    }
    if(!record)return
    busy=true
    try{
      const account=state.accounts.find(a=>a.id===record.account)
      if(eligible(record,account,state)) {
        const mode=account.mode,config=settings(),group=title(record,account)
        const event=eventFor(state,record,account,group,m=>author(m,account))
        const response=await fetch(url,{method:'POST',redirect:'error',signal:AbortSignal.timeout(240000),
          headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.WHATSIA_BROKER_TOKEN},
          body:JSON.stringify({event,provider:{mode,tokens:config.autoTokens,model:mode==='local'?config.autoLocalModel:config.autoCloudModel,
            shared:mode==='cloud'&&config.useBroker,key:mode==='cloud'&&!config.useBroker?config.apiKey:undefined}})})
        if(!response.ok)throw Error('Processamento pendente.')
        const {effects,next}=await response.json()
        if(next!==null&&!/^[a-f0-9]{64}$/.test(next))throw Error('Resposta inválida.')
        if(!active()||account.mode!==mode)return
        if(state.accounts.includes(account)&&state.messages.includes(record)&&eligible(record,account,state)) {
          applyEffects(state,record,account,group,effects)
          if(next){record.managedCursor=next;delete record.managedRetryAt;return}
        }
      }
      pending.delete(record)
      record.managedComplete=true
      delete record.managedCursor
      delete record.managedPending
      delete record.managedRetryAt
    }catch{record.managedRetryAt=Date.now()+60000}
    finally{busy=false;save()}
  }
  const timer=setInterval(()=>tick().catch(()=>{}),1500)
  timer.unref()
  return record=>{
    if(!record.fromMe && !record.managedComplete) {
      record.managedPending=true
      pending.add(record)
    }
  }
}
module.exports={eligible,eventFor,applyEffects,startManagedMessages}
