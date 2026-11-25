const el=id=>document.getElementById(id)
const msg=s=>el('feedback').textContent=s
const field=(tag,text)=>Object.assign(document.createElement(tag),{textContent:text})
let me
let reset=location.hash.startsWith('#senha=')?location.hash.slice(7):''
if(reset) history.replaceState(null,'','/')
async function api(url,method='GET',data) {
  const r=await fetch(url,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined})
  const json=r.status===204?null:await r.json()
  if(!r.ok) throw Error(json.error||'Operação indisponível.')
  return json
}
function action(fn) {return async event=>{
  event?.preventDefault()
  try {msg('');await fn()}catch(e){msg(e.message)}
}}
function input(form,label,name,type,value='') {
  const row=field('label',label),box=document.createElement('input')
  box.type=type;box.name=name;box.value=value
  row.append(box);form.append(row);return box
}
let users = null
let rules = null
const navButtons = Array.from(el('nav').querySelectorAll('button'))
const has = permission => me.permissions.includes(permission)
const canList = () => ['users','usage','quota','permissions'].some(has)
const formatted = new Intl.NumberFormat('pt-BR', {maximumFractionDigits: 1})
function size(bytes) {
  if (bytes === 0) return '0 GiB'
  if (bytes < 2**20) return formatted.format(bytes/1024)+' KiB'
  if (bytes < 2**30) return formatted.format(bytes/2**20)+' MiB'
  return formatted.format(bytes/2**30)+' GiB'
}
function badge(text, enabled) {
  const node=field('span',text)
  node.className=enabled?'badge':'badge off'
  return node
}
function metric(label, value, hint, icon) {
  const card=document.createElement('article')
  card.className='metric'
  const mark=document.createElement('div')
  mark.className='metric-icon'
  const ns='http://www.w3.org/2000/svg'
  const svg=document.createElementNS(ns,'svg'),use=document.createElementNS(ns,'use')
  svg.setAttribute('aria-hidden','true')
  use.setAttribute('href','#i-'+icon)
  svg.append(use);mark.append(svg)
  card.append(field('span',label),mark,field('strong',value),field('small',hint))
  return card
}
function renderOverview() {
  const cards=[]
  if(canList() && users) cards.push(metric('Usuários',users.length,users.filter(u=>u.enabled).length+' com conta ativa','users'))
  if(has('usage') && users) {
    const measured=users.filter(u=>u.used!=null)
    const used=measured.reduce((sum,u)=>sum+u.used,0)
    const pending=users.length-measured.length
    const quota=users.reduce((sum,u)=>sum+u.quotaGiB,0)
    cards.push(metric('Disco utilizado',measured.length?size(used):'—',
      pending?pending+' em apuração':'Cota total de '+formatted.format(quota)+' GiB','disk'))
    const list=el('storage-list')
    list.replaceChildren()
    const sorted=[...users].sort((a,b)=>(b.used??-1)-(a.used??-1)).slice(0,5)
    for(const user of sorted) {
      const row=document.createElement('div'),line=document.createElement('div')
      row.className='storage-row';line.className='line'
      line.append(field('strong',user.email),field('span',user.used==null?'—':size(user.used)))
      const bar=document.createElement('progress')
      bar.max=100;bar.setAttribute('aria-label','Uso da cota de '+user.email)
      if(user.used!=null) bar.value=100*user.used/(user.quotaGiB*2**30)
      row.append(line,bar,field('small',user.used==null?'Consumo em apuração':'Cota de '+formatted.format(user.quotaGiB)+' GiB'))
      list.append(row)
    }
    if(!sorted.length) list.append(field('p','Nenhum usuário cadastrado.'))
    el('storage').hidden=false
  }
  if(has('adminSkills') && rules) cards.push(metric('Skills ativas',rules.filter(r=>r.active).length,
    rules.length===1?'1 regra cadastrada':rules.length+' regras cadastradas','skills'))
  el('metrics').replaceChildren(...cards)
}
function showPage(id, focus=true) {
  const active=navButtons.find(button=>button.dataset.page===id && !button.hidden)
  if(!active) return
  for(const button of navButtons) {
    const selected=button===active
    el(button.dataset.page).hidden=!selected
    if(selected) button.setAttribute('aria-current','page')
    else button.removeAttribute('aria-current')
  }
  el('page-title').textContent=active.textContent
  if(focus) el('page-title').focus()
}
for(const button of navButtons) button.onclick=()=>showPage(button.dataset.page)
el('see-users').onclick=()=>showPage('admin')
el('invite-toggle').onclick=()=>{
  const form=el('invite')
  form.hidden=!form.hidden
  el('invite-toggle').setAttribute('aria-expanded',String(!form.hidden))
  if(!form.hidden) form.elements.email.focus()
}
el('search').oninput=renderUsers
async function list(reopen) {
  users=await api('/admin/users')
  renderUsers(reopen)
  renderOverview()
}
const permissionGroups = [
  {title:'Usuários e acesso', keys:['users','permissions']},
  {title:'Armazenamento', keys:['usage','quota']},
  {title:'IA e automação', keys:['ai','adminSkills']}
]
const permissionDescriptions = {
  users:'Criar usuários e ativar ou desativar contas.',
  permissions:'Conceder ou retirar os acessos que você também possui.',
  usage:'Ver o uso de disco de cada usuário.',
  quota:'Definir o limite de armazenamento de cada conta.',
  ai:'Configurar a chave e os modelos de IA compartilhados.',
  adminSkills:'Criar, editar e pausar regras administrativas.'
}

function permissionEditor(row) {
  const panel=document.createElement('div'), checks=new Map()
  const count=field('p','')
  count.className='grant-count'
  panel.append(count)
  const groups=[...permissionGroups]
  const other=Object.keys(me.labels).filter(key=>!groups.some(group=>group.keys.includes(key)))
  if(other.length) groups.push({title:'Outras permissões',keys:other})
  for(const {title,keys} of groups) {
    const available=keys.filter(key=>Object.hasOwn(me.labels,key))
    if(!available.length) continue
    const section=document.createElement('fieldset')
    section.className='grant-group'
    section.append(field('legend',title))
    for(const key of available) {
      const label=document.createElement('label'),box=document.createElement('input')
      const copy=document.createElement('span')
      label.className='grant-option'
      box.type='checkbox';box.checked=row.permissions.includes(key);box.disabled=!has(key)
      box.name=key
      copy.append(field('strong',me.labels[key]))
      if(permissionDescriptions[key]) copy.append(field('small',permissionDescriptions[key]))
      if(box.disabled) copy.append(field('small','Somente leitura'))
      label.append(box,copy);section.append(label);checks.set(key,box)
    }
    panel.append(section)
  }
  function selected() { return [...checks].filter(([,box])=>box.checked).map(([key])=>key) }
  function updateCount(){
    const n=selected().length
    count.textContent=n+' de '+checks.size+(checks.size===1?' permissão selecionada':' permissões selecionadas')
  }
  panel.addEventListener('change',updateCount);updateCount()
  return {panel,selected}
}

function userEditorTabs(uid,panels,initial) {
  const bar=document.createElement('div')
  bar.className='user-tabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label','Configurações do usuário')
  let current
  const tabs=panels.map(({key,title,panel})=>{
    const tab=field('button',title),id='user-'+uid+'-'+key
    tab.type='button';tab.id=id+'-tab';tab.setAttribute('role','tab');tab.setAttribute('aria-controls',id)
    panel.id=id;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id)
    bar.append(tab)
    return {key,tab,panel}
  })
  function select(key,focus=false){
    current=key
    for(const item of tabs){
      const active=item.key===key
      item.tab.setAttribute('aria-selected',String(active));item.tab.tabIndex=active?0:-1
      item.panel.hidden=!active
      if(active&&focus) item.tab.focus()
    }
  }
  tabs.forEach(({key,tab},index)=>{
    tab.onclick=()=>select(key)
    tab.onkeydown=event=>{
      const last=tabs.length-1
      const next={ArrowLeft:(index+last)%tabs.length,ArrowRight:(index+1)%tabs.length,Home:0,End:last}[event.key]
      if(next===undefined)return
      event.preventDefault();select(tabs[next].key,true)
    }
  })
  select(tabs.some(t=>t.key===initial)?initial:tabs[0].key)
  return {bar,current:()=>current,select}
}

function renderUsers(reopen) {
  const term=el('search').value.trim().toLowerCase()
  const rows=(users??[]).filter(row=>row.email.toLowerCase().includes(term))
  el('users').replaceChildren()
  if(!rows.length) {
    const empty=field('p',term?'Nenhum usuário encontrado.':'Nenhum usuário cadastrado.')
    empty.className='empty';el('users').append(empty)
  }
  for(const row of rows) {
    const entry=document.createElement('details'),form=document.createElement('form')
    const summary=document.createElement('summary'),avatar=field('span',row.email[0].toUpperCase()),email=field('strong',row.email)
    avatar.className='avatar';avatar.setAttribute('aria-hidden','true')
    summary.className='user-summary';email.className='email';form.className='edit'
    summary.append(avatar,email,badge(row.enabled?'Ativa':'Desativada',row.enabled));entry.append(summary,form)
    const accountPanel=document.createElement('div')
    accountPanel.className='account-settings'
    if(row.used!==undefined) accountPanel.append(field('p',usage(row.used,row.quotaGiB)))
    const inputs={}
    if(me.permissions.includes('users')) inputs.enabled=input(accountPanel,' Conta ativa','enabled','checkbox')
    if(inputs.enabled) inputs.enabled.checked=row.enabled
    if(me.permissions.includes('quota')) {
      inputs.quota=input(accountPanel,'Cota em GiB','quota','number',row.quotaGiB);inputs.quota.min=1;inputs.quota.max=4096
    }
    const grants=row.permissions ? permissionEditor(row) : null
    const panels=[]
    if(accountPanel.childElementCount) panels.push({key:'account',title:'Conta',panel:accountPanel})
    if(grants) panels.push({key:'permissions',title:'Permissões',panel:grants.panel})
    const restore=reopen?.id===row.id
    const tabs=panels.length>1 ? userEditorTabs(row.id,panels,restore?reopen.tab:'permissions') : null
    if(tabs) form.append(tabs.bar)
    for(const {panel,title} of panels) {
      if(!tabs) panel.prepend(field('h3',title))
      form.append(panel)
    }
    form.addEventListener('invalid',event=>{
      if(accountPanel.contains(event.target)) tabs?.select('account')
    },true)
    if(inputs.enabled||inputs.quota||grants) {
      form.append(field('button','Salvar alterações'))
      form.onsubmit=action(async()=>{
        const changes={revision:row.revision}
        if(inputs.enabled) changes.enabled=inputs.enabled.checked
        if(inputs.quota) changes.quotaGiB=inputs.quota.valueAsNumber
        if(grants) changes.permissions=grants.selected()
        await api('/admin/users/'+row.id,'PATCH',changes)
        if(row.email===me.email && grants && me.permissions.some(p=>!changes.permissions.includes(p))) {
          location.reload();return
        }
        await list({id:row.id,tab:tabs?.current()})
        msg('Alterações salvas.')
      })
    }
    if(restore) entry.open=true
    el('users').append(entry)
    if(restore) (form.querySelector('[aria-selected=true]') || summary).focus({preventScroll:true})
  }
}
function usage(bytes,quota) {
  if(bytes==null) return 'Consumo em apuração · cota de '+quota+' GiB'
  const percent=Math.round(bytes/(quota*2**30)*100)
  return size(bytes)+' de '+formatted.format(quota)+' GiB'+(percent>=80?' · cota próxima do limite':'')
}
async function shared() {
  const config=await api('/admin/ai'),form=el('defaults')
  const labels={chatCloudModel:'Conversas · nuvem',autoCloudModel:'Análise automática · nuvem',visionCloudModel:'Imagens · análise na nuvem',imageModel:'Geração de imagens',chatLocalModel:'Conversas · local',autoLocalModel:'Análise automática · local',visionLocalModel:'Imagens · análise local'}
  form.replaceChildren()
  for(const [k,v] of Object.entries(labels)) input(form,v,k,'text',config[k]||'')
  input(form,config.sharedKey?'Substituir chave configurada':'Chave compartilhada','apiKey','password')
  input(form,'Remover chave compartilhada','clear','checkbox')
  form.append(field('button','Salvar padrões'))
  form.onsubmit=action(async()=>{
    const data=Object.fromEntries(Object.keys(labels).map(k=>[k,form.elements[k].value.trim()]))
    if(form.elements.clear.checked||form.elements.apiKey.value) data.apiKey=form.elements.clear.checked?'':form.elements.apiKey.value
    await api('/admin/ai','PATCH',data);await shared();msg('Padrões atualizados.')
  })
}
let editingRule
const ruleForm=el('rule-editor')
function editRule(rule) {
  editingRule=rule
  ruleForm.reset()
  if(rule) for(const key of ['name','group','instruction','action']) ruleForm.elements[key].value=rule[key]
  ruleForm.elements.active.checked=rule?.active??true
  el('delete-rule').hidden=!rule
  ruleForm.hidden=false
  ruleForm.elements.name.focus()
}
async function loadRules() {
  rules=await api('/admin/skills')
  const list=el('rule-list')
  list.replaceChildren(...rules.map(rule=>{
    const button=field('button',rule.name)
    button.append(badge(rule.active?'Ativa':'Pausada',rule.active))
    button.onclick=()=>editRule(rule)
    const row=document.createElement('div');row.className='rule-row';row.append(button);return row
  }))
  if(!rules.length) {
    const empty=field('p','Nenhuma skill cadastrada.')
    empty.className='empty';list.append(empty)
  }
  renderOverview()
}
el('new-rule').onclick=()=>editRule(null)
el('cancel-rule').onclick=()=>{ruleForm.hidden=true}
ruleForm.onsubmit=action(async()=>{
  const values=Object.fromEntries(new FormData(ruleForm))
  values.active=ruleForm.elements.active.checked
  if(editingRule) values.revision=editingRule.revision
  await api('/admin/skills'+(editingRule?'/'+editingRule.id:''),editingRule?'PUT':'POST',values)
  await loadRules();ruleForm.hidden=true;msg('Skill salva.')
})
el('delete-rule').onclick=action(async()=>{
  if(!editingRule||!confirm('Excluir esta skill administrativa?'))return
  await api('/admin/skills/'+editingRule.id,'DELETE',{revision:editingRule.revision})
  await loadRules();ruleForm.hidden=true;msg('Skill excluída.')
})
async function init() {
  if(reset){el('reset').hidden=false;return}
  try {me=await api('/me')}catch{el('login').hidden=false;return}
  el('identity').textContent=me.email
  el('avatar').textContent=me.email[0].toUpperCase();el('avatar').title=me.email
  el('scope').textContent=me.permissions.length?'Administração':'Minha conta'
  el('usage').textContent=usage(me.used,me.quotaGiB)
  if(me.used!=null) {
    const percent=100*me.used/(me.quotaGiB*2**30)
    el('personal-bar').value=percent;el('personal-percent').textContent=formatted.format(percent)+'%'
  }
  el('space-status').textContent=me.ready?'Disponível para abrir':'Aguardando inicialização'
  const allowed={overview:true,admin:canList(),'admin-skills':has('adminSkills'),shared:has('ai')}
  for(const button of navButtons) button.hidden=!allowed[button.dataset.page]
  el('invite-toggle').hidden=!has('users')
  el('profile').hidden=el('nav').hidden=el('dashboard').hidden=false
  showPage('overview',false)
  const loads=[]
  if(canList()) loads.push(list())
  if(has('adminSkills')) loads.push(loadRules())
  if(has('ai')) loads.push(shared())
  await Promise.all(loads)
}
el('credentials').onsubmit=action(async()=>{await api('/auth/login','POST',Object.fromEntries(new FormData(el('credentials'))));location.reload()})
el('exit').onclick=action(async()=>{await api('/auth/logout','POST',{});location.reload()})
el('open').onclick=action(async()=>{location.assign((await api('/auth/open','POST',{})).url)})
el('recover').onclick=action(async()=>{const email=el('credentials').elements.email;if(!email.reportValidity())return;await api('/auth/request','POST',{email:email.value});msg('Se o e-mail estiver cadastrado, você receberá o link de acesso.')})
el('new-password').onsubmit=action(async()=>{await api('/auth/password','POST',{token:reset,password:el('new-password').elements.password.value});location.replace('/')})
el('invite').onsubmit=action(async()=>{await api('/admin/users','POST',{email:el('invite').elements.email.value});el('invite').reset();el('invite').hidden=true;el('invite-toggle').setAttribute('aria-expanded','false');await list();msg('Usuário criado. Ele pode solicitar o link de primeiro acesso na tela de login.')})
init().catch(e=>msg(e.message))
