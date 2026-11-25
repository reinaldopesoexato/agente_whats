(() => {
  const key = 'whatsia.browserNotifications'
  const cursorKey = key + '.cursor'
  const fields = {messages:byId('notice-messages'),cards:byId('notice-cards')}
  const audience = byId('notice-audience')
  const quiet = byId('notice-quiet')
  const privateNotice = byId('notice-private')
  const status = byId('notice-status')
  const supported = window.isSecureContext && 'Notification' in window && 'serviceWorker' in navigator
  let controller, mode = '', requesting = false
  function preferences() {
    try { return JSON.parse(localStorage.getItem(key)) || {} } catch { return {} }
  }
  function stop() {
    controller?.abort()
    controller = null
    mode = ''
  }
  async function listen(signal, prefs) {
    await navigator.serviceWorker.register('/notification-worker.js')
    const registration = await navigator.serviceWorker.ready
    if (signal.aborted) return
    const params = new URLSearchParams({messages:Number(!!prefs.messages),cards:Number(!!prefs.cards)})
    const cursor = JSON.parse(localStorage.getItem(cursorKey) || 'null')
    if (cursor && Date.now()-cursor.at < 120000) params.set('after',cursor.id)
    const events = new EventSource('/api/notifications/events?' + params)
    const remember = event => localStorage.setItem(cursorKey,JSON.stringify({id:event.lastEventId,at:Date.now()}))
    events.addEventListener('ready',remember)
    events.onmessage = event => {
      remember(event)
      if (signal.aborted || Notification.permission !== 'granted') return
      const notice = JSON.parse(event.data)
      const settings = preferences()
      if (notice.kind === 'message') {
        const group = notice.chat?.endsWith('@g.us')
        if ((settings.audience === 'groups' && !group) || (settings.audience === 'people' && group)) return
      }
      if (settings.privateNotice) notice.body = 'WhatsIA'
      const selection = localStorage.getItem('whatsia.todayAccount') || 'all'
      if (notice.kind === 'card' && selection !== 'all' && selection !== notice.account) return
      registration.active?.postMessage({action:'notify',id:event.lastEventId,notice,silent:settings.quiet===true})
    }
    events.onerror = () => { if (!signal.aborted) status.textContent = 'Aguardando conexão com o WhatsIA…' }
    events.onopen = () => { status.textContent = 'Ativas enquanto o WhatsIA estiver aberto no navegador.' }
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}))
    events.close()
  }
  const test=byId('notice-test'), enableBackground=byId('enable-background')
  let registration, publicKey, initialized=false, subscribed=false, queue=Promise.resolve()
  async function device(sub,prefs) {
    const response=await fetch('/api/notifications/push/device',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({subscription:sub.toJSON(),preferences:{...prefs,messages:!!prefs.messages,cards:!!prefs.cards,account:localStorage.getItem('whatsia.todayAccount')||'all'}})})
    if(!response.ok) throw Error('Falha ao salvar as preferências de push.')
  }
  async function init(){
    if (supported) {
      try{
        await navigator.serviceWorker.register('/notification-worker.js')
        registration=await navigator.serviceWorker.ready
        await loadKey()
      } catch {}
    }
    initialized=true
    sync()
  }
  async function loadKey(){
    if(!registration?.pushManager || publicKey) return
    const response=await fetch('/api/notifications/push/key')
    if (!response.ok) throw Error('Push indisponível')
    const {key}=await response.json()
    publicKey=Uint8Array.from(atob(key.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0))
  }
  function render(){
    const p=preferences()
    audience.value=p.audience||'all';quiet.checked=!!p.quiet;privateNotice.checked=!!p.privateNotice
    for(const [type,input] of Object.entries(fields)) {
      input.checked=supported && Notification.permission==='granted' && !!p[type]
      input.disabled=!initialized || !supported || requesting
    }
    test.hidden=!subscribed
    enableBackground.hidden=!initialized || !publicKey || subscribed || !(p.messages||p.cards)
  }
  function sync() {
    render()
    if(!initialized || requesting) return
    queue=queue.catch(()=>{}).then(reconcile).catch(()=>{
      status.textContent='Falha ao sincronizar os avisos. Verifique a conexão e tente novamente.'
    })
  }
  async function reconcile(){
    const p=preferences()
    if(!supported) {status.textContent='No iPhone, abra o WhatsIA pelo ícone na Tela de Início para ativar os avisos.';return}
    const allowed=Notification.permission==='granted'
    const enabled=allowed && !!(p.messages||p.cards)
    let sub=await registration?.pushManager?.getSubscription()
    subscribed=false
    if(sub){
      if(enabled){
        await device(sub,p)
        subscribed=true
        stop();render()
        status.textContent='Push ativo neste aparelho, inclusive com o WhatsIA fechado.'
        return
      }
      try {await device(sub,{messages:false,cards:false})} finally {await sub.unsubscribe()}
    }
    render()
    if(!enabled) {
      stop()
      status.textContent=Notification.permission==='denied'?'As notificações estão bloqueadas nas configurações do aparelho.':'Escolha os avisos que deseja receber neste aparelho.'
      return
    }
    const next=[!!p.cards,!!p.messages].join('/')
    if(next!==mode) {
      stop();mode=next;controller=new AbortController()
      const signal=controller.signal
      const stream=()=>listen(signal,p)
      const task=navigator.locks?navigator.locks.request('whatsia-notification-feed',{signal},stream):stream()
      task.catch(()=>{if(!signal.aborted) stop()})
    }
    status.textContent='Avisos ativos enquanto o WhatsIA estiver aberto.'
    if(!publicKey) await loadKey()
  }
  for(const [type,input] of Object.entries(fields)){
    input.onchange=async()=>{
      const enabled=input.checked
      requesting=true
      try {
        for(const control of Object.values(fields)) control.disabled=true
        if(enabled && registration?.pushManager && publicKey) {
          // Subscribe from the tap itself, as required on the iOS Home Screen.
          await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKey})
        } else if(enabled && Notification.permission!=='granted' && await Notification.requestPermission()!=='granted') {
          throw Error('Permissão de notificação indisponível neste aparelho.')
        }
        localStorage.setItem(key,JSON.stringify({...preferences(),[type]:enabled}))
        requesting=false;sync()
      } catch {
        requesting=false;render()
        status.textContent='Não foi possível ativar os avisos. Confira a permissão de notificações e a conexão deste aparelho.'
      }
    }
  }
  for(const control of [audience,quiet,privateNotice]) control.onchange=()=>{
    localStorage.setItem(key,JSON.stringify({...preferences(),audience:audience.value,quiet:quiet.checked,privateNotice:privateNotice.checked}));sync()
  }
  enableBackground.onclick=async()=>{
    enableBackground.disabled=true
    try {
      await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:publicKey})
      sync()
    } catch {status.textContent='Para receber com o app fechado, permita notificações nas configurações deste aparelho.'}
    finally {enableBackground.disabled=false}
  }
  test.onclick=async()=>{
    test.disabled=true
    try{
      const sub=await registration.pushManager.getSubscription()
      const r=await fetch('/api/notifications/push/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({endpoint:sub.endpoint})})
      status.textContent=r.ok?'Teste aceito pelo serviço de push. Confira os avisos do aparelho.':'Falha no teste. Confira a permissão e tente novamente.'
    } catch{status.textContent='Não foi possível enviar o teste.'}
    finally{test.disabled=false}
  }
  async function openNotice(notice) {
    if (!notice || !['message','card'].includes(notice.kind)) return
    if (!model.accounts.length) {
      model.accounts = await api('/api/accounts')
      renderTodayAccounts()
    }
    if (!model.accounts.some(a=>a.id===notice.account)) return
    if (byId('accounts-drawer').open) byId('accounts-drawer').close()
    if (notice.kind === 'message') return openChat(notice.account,notice.chat,notice.message)
    if (todayScope !== 'all' && todayScope !== notice.account) changeTodayScope(notice.account)
    show('today')
    await refreshTodayCards()
    const section = notice.category === 'attachments' ? byId('attachment-panel') : document.getElementById(notice.category)
    if (!section || section.hidden) return
    if (section.tagName === 'DETAILS') section.open = true
    const check = [...section.querySelectorAll('.today-card-check')].find(el=>JSON.parse(el.dataset.identity)[0]===notice.key)
    const target = check?.closest('article') || section
    target.scrollIntoView({block:'center'})
  }
  navigator.serviceWorker?.addEventListener('message',event=>{
    if (event.data?.action === 'open-notification') openNotice(event.data.notice).catch(e=>error(e.message))
    if (event.data?.action === 'notification-error') status.textContent = 'O navegador não conseguiu exibir o aviso. Confira a permissão deste site.'
  })
  if (location.hash.startsWith('#notice=')) {
    const fragment = location.hash.slice(8)
    history.replaceState(null,'',location.pathname + location.search)
    try { openNotice(JSON.parse(decodeURIComponent(fragment))).catch(e=>error(e.message)) } catch {}
  }

  window.addEventListener('storage',event=>{if ([key,'whatsia.todayAccount',null].includes(event.key)) sync()})
  window.addEventListener('whatsia-notice-scope',sync)
  window.addEventListener('pagehide',stop)
  window.addEventListener('pageshow',sync)
  window.addEventListener('online',sync)
  window.addEventListener('focus',sync)
  render()
  init()
})()
