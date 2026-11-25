const waDialog = byId('wa-dialog')
const waForm = byId('wa-form')
const waInputs = waForm.elements
const waStatus = byId('wa-state')
const waOutput = byId('wa-output')
const waScopes = { account:'Conta', chat:'Conversa', message:'Mensagem', group:'Grupo', contact:'Contato', channel:'Canal' }
let waCatalog, waEditing, waSaving, waWorking = false, waFileUrl, waDraw = 0

function waChoices(select, rows) {
  select.replaceChildren(...rows.map(([value,label]) => new Option(label,value)))
}
function waPost(account, body) {
  return api(accountUrl(account) + '/whatsapp/action', 'POST', body)
}
function waDownloadClear() {
  waOutput.replaceChildren()
  if (waFileUrl) URL.revokeObjectURL(waFileUrl)
  waFileUrl = null
}
function displayWaResult(result) {
  waDownloadClear()
  if (result == null) { if (waInputs.operation.value === 'message.getReactions') waOutput.append(element('p','Nenhuma reação.')); return }
  if (result.download) {
    const f = result.download
    const bytes = Uint8Array.from(atob(f.data), c=>c.charCodeAt(0))
    waFileUrl = URL.createObjectURL(new Blob([bytes],{type:'application/octet-stream'}))
    const link = element('a','Baixar ' + f.name)
    link.download = f.name
    link.href = waFileUrl
    waOutput.append(link)
    return
  }
  if (Array.isArray(result) && waInputs.operation.value === 'message.getReactions') {
    if (!result.length) waOutput.append(element('p','Nenhuma reação.'))
    for (const group of result) {
      const list = (group.senders || []).map(item=>item.sender || '').filter(Boolean)
      waOutput.append(element('p',(group.aggregateEmoji || group.id) + ' · ' + list.length + (list.length ? ' · ' + list.join(', ') : '')))
    }
    return
  }
  if (Array.isArray(result) && waInputs.operation.value === 'group.participants') {
    for (const person of result) {
      const line = element('p',person.name || person.id)
      if (person.owner || person.admin) line.append(element('small', person.owner ? ' · Criador' : ' · Administrador'))
      if (person.name) line.append(element('small',' · '+person.id))
      waOutput.append(line)
    }
    return
  }
  const output = element('pre',typeof result === 'string' ? result : JSON.stringify(result,null,2))
  waOutput.append(output)
}
function waMode(saving) {
  waSaving = saving
  byId('wa-title').textContent = saving ? (waEditing ? 'Editar skill do WhatsApp' : 'Nova skill do WhatsApp') : (waEditing?.name || 'Ações do WhatsApp')
  byId('wa-skill-fields').hidden = !saving
  waInputs.skillName.required = saving
  waInputs.descriptionSkill.required = saving
  byId('wa-as-skill').hidden = saving || Boolean(waEditing)
  byId('wa-submit').textContent = saving ? 'Salvar skill' : (waCatalog.operations.find(x=>x.id===waInputs.operation.value)?.read ? 'Consultar' : 'Executar')
}
function waTargetChoices(channels = []) {
  const account = model.accounts.find(a=>a.id===waInputs.account.value)
  const entries = new Map(Object.entries(account?.chatNames || {}))
  for (const item of model.chats) if (item.accountId === account?.id) entries.set(item.id,item.name)
  for (const item of channels) if (item.id) entries.set(item.id,item.name)
  const scope = waInputs.operation.value.split('.')[0]
  byId('wa-chats').replaceChildren(...[...entries].filter(([id])=>scope==='channel'?id.endsWith('@newsletter'):scope!=='group'||id.endsWith('@g.us')).map(([id,name])=>new Option(name || id,id)))
}
async function drawWaFields(values = {}) {
  const draw = ++waDraw
  const spec = waCatalog.operations.find(item=>item.id===waInputs.operation.value)
  if (!spec) return
  const readonly = Boolean(waEditing && !waSaving)
  const fields = byId('wa-fields')
  fields.replaceChildren()
  waDownloadClear()
  waStatus.textContent = ''
  byId('wa-chat-label').hidden = spec.scope === 'account' && !waSaving
  byId('wa-msg-label').hidden = spec.scope !== 'message'
  byId('wa-contact-label').hidden = spec.scope !== 'contact'
  waInputs.chat.required = !['account','contact'].includes(spec.scope)
  waInputs.message.required = spec.scope==='message' && !waSaving
  waMode(waSaving)
  waTargetChoices()
  const account = waInputs.account.value
  const chat = waInputs.chat.value
  byId('wa-msgs').replaceChildren(...(account===model.account && chat===model.chat ? model.messages.map(m=>new Option((m.media ? 'Anexo' : m.body || m.type || '').slice(0,70),m.id)):[]))
  for (const key of spec.fields) {
    const label = element('label',waCatalog.fields[key])
    const input = element(['options','votes','labels','text','users','groups'].includes(key) ? 'textarea' : key==='callType' ? 'select':'input')
    input.dataset.param = key
    input.disabled = readonly
    if (key==='callType') waChoices(input,[['voice','Voz'],['video','Vídeo']])
    if (['multiple','enabled'].includes(key)) { input.type='checkbox'; input.checked=values[key]===true }
    else if (key==='file') { input.type='file'; if (values.file?.name) label.append(element('small',values.file.name)) }
    else {
      if (['limit','days','latitude','longitude','choice'].includes(key)) {
        input.type='number'
        input.step=['latitude','longitude'].includes(key)?'any':'1'
      }
      if (key==='when') input.type='datetime-local'
      const value=values[key] ?? ({days:1,limit:30,choice:0,callType:'voice'}[key] || '')
      input.value = Array.isArray(value) ? value.join('\n') : value
      if (key==='when' && values[key]) {
        const d=new Date(values[key]); input.value=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)
      }
      if (key==='users' || key==='groups') input.placeholder='Um ID por linha'
    }
    label.append(input)
    fields.append(label)
    if (readonly) continue
    if (key==='emoji') {
      const strip=element('div')
      for (const emoji of ['👍','❤️','😂','😮','😢','🙏','']) strip.append(button(emoji || 'Retirar',()=>{input.value=emoji}))
      fields.append(strip)
    }
    if (key==='votes' && model.account===account && model.chat===chat) {
      const options=model.messages.find(m=>m.id===waInputs.message.value)?.poll?.options || []
      if (options.length) fields.append(element('small','Opções: '+options.join(' · ')))
    }
    if (key==='users' || key==='groups') {
      const pick=element('select')
      pick.setAttribute('aria-label',key==='users'?'Escolher participante ou contato':'Escolher grupo')
      const names=model.accounts.find(a=>a.id===account)?.chatNames || {}
      const choices=Object.entries(names).filter(([id])=>key==='groups'?id.endsWith('@g.us'):/@(lid|c\.us)$/.test(id))
      const setChoices=rows=>waChoices(pick,[['','Adicionar à seleção…'],...rows])
      setChoices(choices)
      pick.onchange=()=>{if(pick.value) input.value=[...new Set([...input.value.split(/[\s,;]+/),pick.value].filter(Boolean))].join('\n');pick.value=''}
      fields.append(pick)
      if (key==='users' && chat.endsWith('@g.us')) waPost(account,{operation:'group.participants',chat}).then(({result})=>{
        if(draw!==waDraw) return
        const peers=result.map(p=>[p.id,p.name || names[p.id] || p.id])
        setChoices(spec.id==='group.addParticipants'?choices:peers)
      }).catch(()=>{})
    }
  }
  if (spec.scope==='channel' || spec.fields.includes('channel')) waPost(account,{operation:'account.getChannels'}).then(({result})=>{
    if(draw!==waDraw) return
    waTargetChoices(result)
    const field=fields.querySelector('[data-param="channel"]')
    if(field) field.setAttribute('list','wa-chats')
  }).catch(()=>{})
}
async function openWhatsAppActions(options={}) {
  if (!waCatalog) waCatalog=await api('/api/whatsapp/actions')
  waEditing=options.skill || null
  if (waEditing?.wa===true) {
    waEditing=(await api('/api/ai/skills')).find(s=>s.id===waEditing.id)
    if (!waEditing?.wa) throw Error('Esta skill já não está disponível.')
  }
  waSaving=Boolean(options.saving)
  const w=waEditing?.wa || options
  waForm.reset()
  waChoices(waInputs.account,model.accounts.map(a=>[a.id,a.name]))
  waInputs.account.value=w.account || model.account || model.accounts[0]?.id || ''
  waInputs.operation.replaceChildren()
  for (const [scope,title] of Object.entries(waScopes)) {
    const group=element('optgroup')
    group.label=title
    for (const op of waCatalog.operations.filter(op=>op.scope===scope)) group.append(new Option(op.label,op.id))
    waInputs.operation.append(group)
  }
  waInputs.operation.value=w.operation || 'account.getChats'
  waInputs.chat.value=w.chat ?? (waInputs.account.value===model.account? model.chat || '' : '')
  waInputs.message.value=w.message || options.message || ''
  waInputs.contact.value=w.contact || ''
  waInputs.skillName.value=waEditing?.name || ''
  waInputs.descriptionSkill.value=waEditing?.description || ''
  waInputs.trigger.value=w.trigger || ''
  waInputs.sender.value=w.sender || ''
  for (const input of [waInputs.account,waInputs.operation,waInputs.chat,waInputs.contact,waInputs.message]) input.disabled=Boolean(waEditing && !waSaving)
  if (waEditing && !waSaving && !w.message) waInputs.message.disabled=false
  await drawWaFields(w.params)
  waDialog.showModal()
  if(options.inspect) waForm.requestSubmit()
}
byId('open-wa-actions').onclick=act(()=>{byId('accounts-drawer').close();return openWhatsAppActions()})
byId('new-wa-skill').onclick=act(()=>openWhatsAppActions({saving:true}))
byId('wa-close').onclick=()=>waDialog.close()
waDialog.addEventListener('close',()=>{waDraw++;waDownloadClear()})
waDialog.addEventListener('cancel',event=>{if(waWorking)event.preventDefault()})
waInputs.account.onchange=()=>{waInputs.chat.value='';waInputs.message.value='';waInputs.contact.value='';drawWaFields()}
waInputs.operation.onchange=()=>drawWaFields()
waInputs.chat.onchange=()=>{waInputs.message.value='';drawWaFields()}
byId('wa-as-skill').onclick=()=>{waMode(true);byId('wa-chat-label').hidden=false;waInputs.message.required=false;waInputs.skillName.focus()}

waForm.onsubmit=async event=>{
  event.preventDefault()
  if(waWorking)return
  waWorking=true
  byId('wa-submit').disabled=byId('wa-close').disabled=true
  waStatus.textContent='Aguarde…'
  const account=waInputs.account.value, chat=waInputs.chat.value.trim(), message=waInputs.message.value.trim()
  const operation=waInputs.operation.value
  try{
    const params={}
    for(const f of byId('wa-fields').querySelectorAll('[data-param]')){
      const key=f.dataset.param
      if(f.type==='file'){
        const file=f.files[0]
        if(file && file.size>10*1024*1024)throw Error('Escolha um arquivo de até 10 MiB.')
        if(file)params.file={data:await encodeChatFile(file),mime:file.type || 'application/octet-stream',name:file.name}
        else if(waEditing)params.file=waEditing.wa.params.file
      } else if(f.type==='checkbox')params[key]=f.checked
      else if(f.type==='datetime-local' && f.value)params[key]=new Date(f.value).toISOString()
      else params[key]=f.value
    }
    const payload={operation,params,account,chat,message,contact:waInputs.contact.value.trim()}
    if(waSaving){
      const wa={...payload,trigger:waInputs.trigger.value.trim(),sender:waInputs.sender.value.trim()}
      await api('/api/ai/skills'+(waEditing?'/'+pathPart(waEditing.id):''),waEditing?'PATCH':'POST',{name:waInputs.skillName.value,description:waInputs.descriptionSkill.value,wa})
      waDialog.close()
      show('skills');await refresh()
      byId('skill-notice').textContent='Skill do WhatsApp salva.'
      return
    }
    const {result}=await waPost(account,waEditing?{skillId:waEditing.id,message}:payload)
    waStatus.textContent=waCatalog.operations.find(op=>op.id===operation)?.read?'Consulta concluída.':'Operação processada pelo WhatsApp.'
    displayWaResult(result)
    if(account===model.account && chat===model.chat && model.tab==='chat'){
      if(operation==='message.react'){
        const reactions=await waPost(account,{operation:'message.getReactions',chat,message})
        const row=model.messages.find(m=>m.id===message)
        if(row) {row.reactions=(reactions.result||[]).map(r=>({emoji:r.aggregateEmoji||r.id,count:r.senders?.length || 0,mine:r.hasReactionByMe}));row.hasReaction=Boolean(row.reactions.length)}
      }
      if(operation==='message.deleteMe') model.messages=model.messages.filter(m=>m.id!==message)
      await refresh()
    }
  }catch(error){waStatus.textContent=error.message}
  finally{waWorking=false;byId('wa-submit').disabled=byId('wa-close').disabled=false}
}

let waMentionSearch, waMentionVersion=0
composer.elements.body.addEventListener('input', async () => {
  const field=composer.elements.body, list=byId('wa-mention-list'), version=++waMentionVersion
  const match=/(?:^|\s)@([^\s@]*)$/.exec(field.value.slice(0,field.selectionStart))
  list.hidden=true
  if(!model.chat?.endsWith('@g.us') || !match)return
  const account=model.account, chat=model.chat, key=account+'/'+chat
  if(waMentionSearch?.key!==key || waMentionSearch.until<Date.now()){
    waMentionSearch={key,until:Date.now()+30000,rows:waPost(account,{operation:'group.participants',chat}).then(r=>r.result)}
  }
  try{
    const members=await waMentionSearch.rows
    if(version!==waMentionVersion || model.account!==account || model.chat!==chat)return
    const names=model.accounts.find(a=>a.id===account)?.chatNames || {}
    const peers=members.map(p=>({id:p.id,name:p.name || names[p.id] || p.id}))
      .filter(p=>filterKey(p.name+' '+p.id).includes(filterKey(match[1]))).slice(0,12)
    list.replaceChildren(...peers.map(p=>button(p.name,()=>{
      const end=field.selectionStart
      field.setRangeText('@'+p.id.split('@')[0]+' ',end-match[1].length-1,end,'end')
      selectedMentions.add(p.id);list.hidden=true;field.focus();renderComposerControls()
    })))
    list.hidden=!peers.length
  }catch{if(waMentionSearch?.key===key)waMentionSearch=null}
})
