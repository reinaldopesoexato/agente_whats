const byId = id => document.getElementById(id)
const model = { accounts: [], chats: [], chatScope: null, messages: [], account: null, chat: null, tab: 'chat', source: null }
const pathPart = encodeURIComponent
const accountUrl = id => '/api/accounts/' + pathPart(id)
const chatUrl = (account, chat) => accountUrl(account) + '/chats/' + pathPart(chat)
let chatStamp = ''
const outgoingClocks = new Map()
let updating = false

let deviceMode = !navigator.onLine
let pendingChatRows = []
let draining = false
const localChatEnabled = window.isSecureContext && !!window.indexedDB
const storageWarning = () => error('Não foi possível salvar neste aparelho. Confira o espaço disponível.')
async function requestJSON(url, method = 'GET', data, timeout = 12000) {
  const response = await fetch(url, { method, ...(method === 'GET' || data?.clientToken ? { signal: AbortSignal.timeout(timeout) } : {}), ...(data === undefined ? {} : {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  }) })
  if (!response.ok) {
    const info = await response.json().catch(() => ({}))
    throw Object.assign(new Error(info.error || 'Erro HTTP ' + response.status), {status:response.status,code:info.code})
  }
  return response.json()
}

async function api(url, method = 'GET', data, timeout = 12000) {
  if (method !== 'GET' || !localChatEnabled) return requestJSON(url,method,data,timeout)
  const {pathname,searchParams} = new URL(url,location.href)
  const accounts = pathname === '/api/accounts'
  const match = /^\/api\/accounts\/([^/]+)\/chats(?:\/([^/]+))?$/.exec(pathname)
  if (!accounts && (!match || (match[2] && !searchParams.has('page')))) return requestJSON(url,method,data,timeout)
  const account = match && decodeURIComponent(match[1])
  const chat = match?.[2] && decodeURIComponent(match[2])
  const key = accounts ? 'accounts' : 'directory/'+account
  let result
  try {
    if (!navigator.onLine || (!accounts && deviceMode)) throw TypeError('Sem conexão')
    result = await requestJSON(url,method,data,timeout)
  } catch (failure) {
    if (failure.status === 401) {
      await caches.delete('whatsia-shell-offline-1')
      location.replace('/?app=1')
      throw failure
    }
    if (failure.status && ![502,503,504].includes(failure.status) || failure instanceof SyntaxError) throw failure
    if (accounts) deviceMode = true
    if (chat) return offlineChat.page(account,chat,searchParams)
    return await offlineChat.lists(key) || []
  }
  if (accounts) deviceMode = false
  // Pairing QR codes, settings and credentials never enter the offline snapshot.
  const snapshot = accounts ? result.map(({id,name,feedback,mode}) => ({id,name,feedback:feedback || [],mode,
    status:'Sem conexão',storedHistory:true})) : result
  try {
    if (chat) await offlineChat.remember(account,chat,Array.isArray(result) ? result : result.messages)
    else await offlineChat.lists(key,snapshot)
  } catch { storageWarning() }
  return result
}

async function updatePending() {
  pendingChatRows = await offlineChat.pending()
  if (model.tab === 'chat' && model.chat) renderChat(model.accounts.find(a=>a.id===model.account))
}

async function sendFromComposer(account,chat,payload) {
  if (!localChatEnabled) return api(chatUrl(account,chat),'POST',payload)
  await offlineChat.enqueue(account,chat,payload)
  await updatePending()
  void drainChatQueue().catch(storageWarning)
}

async function drainChatQueue() {
  if (draining || !localChatEnabled || deviceMode || !navigator.onLine) return
  draining = true
  async function drain() {
    const blocked = new Set()
    for (const row of await offlineChat.pending()) {
      if (!navigator.onLine) break
      const thread = JSON.stringify([row.account,row.chat])
      if (row.reason || blocked.has(thread) || !model.accounts.some(a=>a.id===row.account && a.status==='Conectado')) continue
      const payload = await offlineChat.payload(row.id)
      if (!payload) continue
      let sent
      try {
        sent = await requestJSON(chatUrl(row.account,row.chat)+'/outbox','POST',{...payload,clientToken:row.id},45000)
      } catch (failure) {
        if (!failure.status || failure.status >= 500 || failure.status === 401) break
        blocked.add(thread)
        if (failure.status !== 409 || failure.code === 'unconfirmed') await offlineChat.fail(row,failure.message)
        continue
      }
      if (!sent?.id) break
      const message = {...sent,body:sent.body || payload.body,media:!!payload.file}
      await offlineChat.finish(row,message)
      if (model.chat === row.chat && model.account === row.account) mergeThreadMessages([message])
    }
    await updatePending()
  }
  try {
    if (navigator.locks) await navigator.locks.request('whatsia-envios',{ifAvailable:true},lock => lock && drain())
    else await drain()
  } finally { draining = false }
}

function error(message) {
  byId('error').textContent = message
  byId('error').hidden = !message
}

function act(handler) {
  return async event => {
    event?.preventDefault()
    try {
      error('')
      await handler(event)
    } catch (failure) {
      error(failure.message)
    }
  }
}

function element(tag, label) {
  const node = document.createElement(tag)
  if (label) node.textContent = label
  return node
}

function button(label, handler, selected = false) {
  const node = element('button', label)
  node.type = 'button'
  node.onclick = act(handler)
  node.classList.toggle('selected', selected)
  return node
}

const mobileChat = matchMedia('(max-width: 760px), (max-width: 960px) and (max-height: 500px) and (pointer: coarse)')
const mobileChatBack = byId('chat-back')
const moreTab = byId('more-tab')
const appBrand = document.querySelector('.app-brand')
const appNav = byId('app-nav')
const directoryMenu = byId('chat-directory-menu')
function placeAccountsMenu() {
  const inDirectory = mobileChat.matches && model.tab === 'chat'
  const parent = inDirectory ? directoryMenu : appNav.parentElement
  if (appBrand.parentElement !== parent) parent.insertBefore(appBrand, inDirectory ? null : appNav)
}
mobileChat.addEventListener('change', placeAccountsMenu)
let directoryScroll = 0
function closeExtraTabs(returnFocus = false) {
  if (moreTab.getAttribute('aria-expanded') !== 'true') return
  moreTab.setAttribute('aria-expanded','false')
  if (returnFocus) moreTab.focus({preventScroll:true})
}
moreTab.onclick = () => {
  moreTab.setAttribute('aria-expanded', String(moreTab.getAttribute('aria-expanded') !== 'true'))
}
document.addEventListener('click', event => {
  if (!event.target.closest('#app-nav')) closeExtraTabs()
})
byId('extra-tabs').addEventListener('click', () => closeExtraTabs())
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && moreTab.getAttribute('aria-expanded') === 'true') {
    closeExtraTabs(true)
    event.preventDefault()
  }
})
byId('app-nav').addEventListener('focusout', event => {
  if (event.relatedTarget && !byId('app-nav').contains(event.relatedTarget)) closeExtraTabs()
})

// Keep the same live analysis controls accessible in Contas on small screens.
const analysisBar = document.querySelector('.analysis-bar')
const analysisHome = analysisBar.nextElementSibling
function placeAnalysisControls() {
  closeExtraTabs()
  if (mobileChat.matches) byId('accounts-drawer').append(analysisBar)
  else analysisHome.before(analysisBar)
}
placeAnalysisControls()
mobileChat.addEventListener('change',placeAnalysisControls)
const themeColor = document.querySelector('meta[name="theme-color"]')
const defaultTheme = themeColor.content
function updateChatTheme() {
  const thread = mobileChat.matches && model.tab === 'chat' && !byId('thread').hidden
  const color = thread ? '#f2efe9' : defaultTheme
  if (themeColor.content !== color) themeColor.content = color
}
function fitMobileChat() {
  updateChatTheme()
  const viewport = window.visualViewport
  const visible = mobileChat.matches && model.tab === 'chat' && viewport?.scale === 1 && viewport.height > 0
  const editing = document.activeElement?.matches('textarea, input:not([type=button]), [contenteditable="true"]')
  const keyboard = visible && editing && document.documentElement.clientHeight - viewport.height > 100
  document.body.toggleAttribute('data-chat-keyboard', Boolean(keyboard))
  if (visible) {
    document.body.style.setProperty('--chat-height', viewport.height + 'px')
    document.body.style.setProperty('--chat-top', viewport.offsetTop + 'px')
    const coveredBottom = Math.max(0, document.documentElement.clientHeight - viewport.height - viewport.offsetTop)
    document.body.style.setProperty('--chat-covered-bottom', coveredBottom + 'px')
  } else {
    document.body.style.removeProperty('--chat-height')
    document.body.style.removeProperty('--chat-top')
    document.body.style.removeProperty('--chat-covered-bottom')
  }
}
window.addEventListener('pageshow',fitMobileChat)
window.addEventListener('resize',fitMobileChat)
document.addEventListener('focusin',fitMobileChat)
document.addEventListener('focusout',() => requestAnimationFrame(fitMobileChat))
window.visualViewport?.addEventListener('resize',fitMobileChat)
window.visualViewport?.addEventListener('scroll',fitMobileChat)
mobileChat.addEventListener('change',fitMobileChat)

function show(tab) {
  closeExtraTabs()
  if (model.tab !== tab && tab === 'people') peopleStamp = ''
  if (model.tab !== tab && tab === 'groups') groupStamp = ''
  byId('skills-view').hidden = tab !== 'skills'
  byId('ai-settings-view').hidden = tab !== 'ai-settings'
  if (tab !== 'ai-settings') byId('ai-preferences').elements.apiKey.value = ''
  model.tab = tab
  placeAccountsMenu()
  fitMobileChat()
  byId('today-view').hidden = tab !== 'today'
  for (const name of ['today', 'groups', 'people', 'chat', 'ai', 'skills']) {
    const tabButton = byId(name + '-tab')
    tabButton.classList.toggle('selected', name === tab)
    if (name === tab) tabButton.setAttribute('aria-current', 'page')
    else tabButton.removeAttribute('aria-current')
  }
  byId('chat-view').hidden = tab !== 'chat'
  byId('ai-view').hidden = tab !== 'ai'
  if (tab === 'ai' && window.innerWidth > 740) setSidebarWidth(Number(localStorage.getItem('whatsia.sidebarWidth')) || 240)
  byId('people-view').hidden = tab !== 'people'
  byId('groups-view').hidden = tab !== 'groups'
}

function newHistory() {
  return { initialized: false, next: null, more: false, older: false, recent: null, focusSource: true, notice: '', expandedMedia: new Set() }
}
let historyWindow = newHistory()

function mergeThreadMessages(messages) {
  const byMessage = new Map(model.messages.map(message => [message.id, message]))
  for (const message of messages) byMessage.set(message.id, message)
  model.messages = [...byMessage.values()].sort((a, b) => a.timestamp - b.timestamp || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function historyMode(account) {
  if (deviceMode && localChatEnabled) return 'device'
  return account.status === 'Conectado' ? 'live' : account.storedHistory ? 'stored' : 'names'
}

function prepareHistory(account) {
  const mode = historyMode(account)
  if (historyWindow.mode && historyWindow.mode !== mode) {
    historyWindow = newHistory()
    model.messages = []
    selectedMessages.clear()
    historyControls()
    if (mode === 'names') resetChatComposer()
  }
  historyWindow.mode = mode
}

function historyControls() {
  const history = historyWindow
  const label = history.older ? 'Carregando mensagens antigas…' : history.notice
  const bar = byId('chat-history-bar')
  bar.hidden = !label
  bar.classList.toggle('is-loading', history.older)
  if (byId('older-status').textContent !== label) byId('older-status').textContent = label
  byId('history-retry').hidden = !(history.notice && history.more && !history.older)
}

async function latestMessages(account, chat, source) {
  const history = historyWindow
  if (!history.recent) {
    const query = new URLSearchParams({ page: '1' })
    if (history.mode === 'stored') query.set('stored', '1')
    if (!history.initialized) query.set('initial', '1')
    if (source) query.set('source', source)
    history.recent = api(chatUrl(account.id, chat) + '?' + query, 'GET', undefined, 35000).then(page => {
      if (history !== historyWindow || model.account !== account.id || model.chat !== chat || model.tab !== 'chat') return []
      if (Array.isArray(page)) {
        history.initialized = true
        history.notice = 'Para carregar mensagens anteriores, reinicie o WhatsIA no terminal.'
        mergeThreadMessages(page)
        historyControls()
        renderChat(account)
        return page
      }
      if (!history.initialized || !history.next) {
        history.next = page.next
        history.more = page.hasMore
      }
      history.initialized = true
      mergeThreadMessages(page.messages)
      if (page.device) history.notice = model.messages.length ? '' : 'Nenhuma mensagem baixada neste aparelho.'
      else if (history.mode === 'stored') history.notice = model.messages.length ? '' : 'Nenhuma mensagem salva nesta conversa.'
      historyControls()
      renderChat(account)
      fillHistoryViewport(history)
      return page.device ? [] : page.messages
    }).catch(failure => {
      if (history === historyWindow && !history.initialized) historyControls()
      throw failure
    }).finally(() => { history.recent = null })
  }
  return history.recent
}

async function olderMessages() {
  const history = historyWindow
  const account = model.accounts.find(item => item.id === model.account)
  if (model.tab !== 'chat' || !account || history.mode === 'names' || !history.more || history.older || !history.next) return
  history.older = true
  history.notice = ''
  historyControls()
  try {
    const query = new URLSearchParams({ page: '1', before: history.next.timestamp, beforeId: history.next.id })
    if (history.mode === 'stored') query.set('stored', '1')
    const page = await api(chatUrl(account.id, model.chat) + '?' + query, 'GET', undefined, 35000)
    if (history !== historyWindow) return
    mergeThreadMessages(page.messages)
    history.more = page.hasMore && page.next && (page.next.timestamp !== history.next.timestamp || page.next.id !== history.next.id)
    history.next = page.next
    renderChat(account)
  } catch (failure) { history.notice = failure.message }
  finally {
    history.older = false
    if (history === historyWindow) {
      historyControls()
      fillHistoryViewport(history)
    }
  }
}
function fillHistoryViewport(history) {
  const list = byId('messages')
  if (history === historyWindow && history.more && !history.notice && list.clientHeight && list.scrollHeight <= list.clientHeight + 1) olderMessages()
}
byId('history-retry').onclick = olderMessages
byId('messages').addEventListener('scroll', () => {
  if (byId('messages').scrollTop < 80 && !historyWindow.notice) olderMessages()
})

function openChat(account, chat, source = null, fromHistory = false) {
  if (mobileChat.matches) {
    const route = history.state?.whatsiaChat
    if (chat && !model.chat && model.tab === 'chat') directoryScroll = byId('chat-view').scrollTop
    if (!fromHistory && chat) {
      const state = {...history.state, whatsiaChat:{account,chat,source}}
      if (route) history.replaceState(state,'')
      else history.pushState(state,'')
    } else if (!fromHistory && route) {
      history.replaceState({...history.state,whatsiaChat:null},'')
    }
  }
  if (model.account !== account || model.chat !== chat || model.source !== source) {
    historyWindow = newHistory()
    historyControls()
    resetChatComposer()
    selectedMessages.clear()
    renderSelection()
    byId('thread').hidden = true
    model.messages = []
    byId('messages').replaceChildren()
    if (model.account !== account) chatDirectoryStamp = ''
  }
  model.account = account
  if (model.chatScope !== 'all') model.chatScope = account
  model.chat = chat
  model.source = source
  chatStamp = ''
  show('chat')
  const selected = model.accounts.find(item => item.id === account)
  if (chat && selected) {
    prepareHistory(selected)
    renderChat(selected)
    if (mobileChat.matches) mobileChatBack.focus({preventScroll:true})
    if (historyWindow.mode === 'names') return refresh()
    if (!historyWindow.initialized) {
      byId('chat-history-bar').hidden = false
      byId('history-retry').hidden = true
      byId('chat-history-bar').classList.add('is-loading')
      byId('older-status').textContent = 'Carregando mensagens…'
    }
    return Promise.all([pollThread(selected, chat, source), refresh()])
  }
  return refresh()
}

function renderAccounts() {
  byId('accounts').replaceChildren(...model.accounts.map(account => {
    const node = button(account.name, () => {
      byId('accounts-drawer').close()
      model.chatScope = account.id
      return openChat(account.id, null)
    }, account.id === model.account)
    const status = account.syncPhase === 'finalizing' ? 'Finalizando conexão' :
      account.status === 'Sincronizando' && Number.isFinite(account.loadingPercent) ? 'Sincronizando · ' + account.loadingPercent + '%' : account.status
    node.append(element('small', [account.number, status].filter(Boolean).join(' · ')))
    return node
  }))
}
let sessionStamp = ''
function renderSession(account) {
  const stamp = JSON.stringify(account)
  if (stamp === sessionStamp) return
  sessionStamp = stamp
  const area = byId('session')
  area.replaceChildren()
  const settings = byId('account-settings')
  settings.replaceChildren()
  settings.hidden = !account
  if (!account) {
    area.append(element('p', 'Vincule uma conta para começar.'))
    return
  }
  const label = element('label', 'Análise automática da conta ')
  const select = element('select')
  for (const [value, text] of [['off', 'Desativada'], ['local', 'Somente local'], ['cloud', 'Híbrida']]) {
    const option = element('option', text)
    option.value = value
    select.append(option)
  }
  select.value = account.mode
  select.onchange = act(async () => {
    await api(accountUrl(account.id), 'PATCH', { mode: select.value })
    await refresh()
  })
  label.append(select)
  settings.append(element('h3', 'Conta ativa · ' + account.name), label)
  const progress = {
    'Na fila de sincronização': 'Aguardando a sincronização da conta anterior…',
    Conectando: 'Iniciando o Chromium…',
    'Carregando WhatsApp Web': 'Carregando web.whatsapp.com no Chromium…',
    'Aguardando vinculação': 'WhatsApp Web carregado. Aguardando o QR Code…',
    'Gerando código': 'Solicitando código de vinculação ao WhatsApp…'
  }
  if (progress[account.status]) area.append(element('p', progress[account.status]))
  if (account.status === 'Sincronizando') {
    const finalizing = account.syncPhase === 'finalizing'
    const caption = finalizing ? 'Finalizando a conexão do WhatsApp…' :
      account.loadingMessage || 'Sincronizando mensagens com o WhatsApp…'
    const percent = !finalizing && Number.isFinite(account.loadingPercent) ? ' ' + account.loadingPercent + '%' : ''
    const status = element('p', caption + percent)
    status.setAttribute('role', 'status')
    area.append(status)
  }
  if (account.linkedAt && ['Aguardando vinculação', 'Aguardando QR'].includes(account.status)) {
    area.append(element('small', 'O WhatsApp está verificando a vinculação salva. Use o QR apenas se for solicitado novamente.'))
  }
  if (account.qr) {
    const image = element('img')
    image.src = account.qr
    image.alt = 'QR Code de vinculação'
    area.append(image, element('p', 'No celular, abra Aparelhos conectados e escaneie o código.'))
  }
  if (account.linkCode) {
    area.append(element('strong', account.linkCode),
      element('p', 'No celular, abra Aparelhos conectados → Conectar um aparelho → Conectar com número de telefone e digite o código.'))
  }
  if (['Aguardando vinculação', 'Aguardando QR', 'Aguardando código'].includes(account.status)) {
    const form = element('form')
    const phone = element('input')
    phone.type = 'tel'
    phone.placeholder = '+55 DDD número'
    phone.setAttribute('aria-label', 'Número com código do país e DDD')
    phone.required = true
    form.append(phone, element('button', 'Vincular por número'))
    form.onsubmit = act(async () => {
      const submit = form.querySelector('button')
      submit.disabled = true
      try {
        await api(accountUrl(account.id) + '/pair-code', 'POST', { phone: phone.value })
        await refresh()
      } finally {
        submit.disabled = false
      }
    })
    area.append(form)
  }
  const reconnect = async visible => {
    await api(accountUrl(account.id) + '/reconnect', 'POST', { visible })
    await refresh()
  }
  if (account.status === 'Sincronizando') {
    area.append(button('Reconectar agora', () => reconnect(account.visible === true)))
  }
  if (account.status === 'Desconectado') {
    area.append(element('small', account.error), button('Reconectar', () => reconnect(false)))
    if (account.retryAt) area.append(element('small', 'Reconexão automática programada'))
  }
  const canOpenWindow = ['Carregando WhatsApp Web', 'Aguardando vinculação', 'Aguardando QR',
    'Aguardando código', 'Desconectado', 'Conectado'].includes(account.status) &&
    (!account.visible || account.status === 'Desconectado')
  if (canOpenWindow) settings.append(button(account.status === 'Conectado' ? 'Abrir janela do Chromium' : 'Abrir vinculação no Chromium', () => reconnect(true)))
  if (account.visible && account.status !== 'Desconectado') settings.append(button('Rodar em segundo plano', () => reconnect(false)))
  else if (account.status === 'Conectado') settings.append(element('small', 'Chromium em segundo plano'))
  if (account.visible && account.status !== 'Desconectado' && account.status !== 'Conectado') {
    area.append(element('p', 'Procure a janela do Chromium aberta pelo WhatsIA para vincular esta conta.'))
  }
}

let activeContext
let historyTimer
const historyForm = byId('history-form')

function historyJobLabel(job) {
  if (job.status === 'loading') return 'Buscando histórico… ' + job.loaded + ' mensagens carregadas.'
  if (job.status === 'analyzing') return 'Processando ' + job.processed + ' de ' + job.total + ' mensagens.'
  if (job.status === 'stopping') return 'Parada solicitada. Aguardando o lote em andamento.'
  if (job.status === 'canceled') return 'Interrompido. ' + job.processed + ' mensagens processadas.'
  if (job.status === 'error') return job.error
  if (job.noChanges) return job.force ? 'Nenhuma mensagem com texto no período.' : 'Nenhuma mensagem nova com texto no período.'
  return 'Concluído. ' + job.processed + ' mensagens processadas.'
}

const historyBusy = job => ['loading', 'analyzing', 'stopping'].includes(job?.status)

function showHistory({ job, history }) {
  const busy = historyBusy(job)
  historyForm.querySelector('button').disabled = busy
  const stop = byId('stop-history')
  stop.hidden = !busy || !job.id
  stop.disabled = job?.status === 'stopping'
  stop.onclick = act(async () => {
    await api(activeContext + '/history', 'PATCH', { action: 'stop', id: job.id })
    await pollHistory(activeContext)
  })
  const status = job ? historyJobLabel(job) : history ? 'Contexto salvo de ' + history.messages + ' mensagens com texto.' : ''
  byId('history-status').textContent = status
  byId('history-summary').hidden = !history
  byId('history-summary').textContent = history?.summary || ''
  return busy
}

async function pollHistory(url) {
  try {
    const data = await api(url)
    if (activeContext !== url || !byId('context-dialog').open) return
    if (showHistory(data)) historyTimer = setTimeout(() => pollHistory(url), 2000)
  } catch (failure) {
    if (activeContext !== url) return
    byId('history-status').textContent = failure.message
    historyForm.querySelector('button').disabled = false
  }
}

historyForm.elements.period.onchange = () => {
  historyForm.elements.days.disabled = historyForm.elements.period.value === 'all'
}
historyForm.onsubmit = async event => {
  event.preventDefault()
  const url = activeContext
  const button = historyForm.querySelector('button')
  button.disabled = true
  try {
    const days = historyForm.elements.period.value === 'all' ? null : Number(historyForm.elements.days.value)
    await api(url + '/history', 'POST', { days })
    await pollHistory(url)
  } catch (failure) {
    byId('history-status').textContent = failure.message
    button.disabled = false
  }
}

const askForm = byId('ask-contexts')
let selectedPerson = null
let selectedGroup = null
let selectedAiChat = crypto.randomUUID()
let selectedWhatsAppContext = null
let selectedReplySource = null
const sendingDeliveries = new Set()
let aiChatStamp = ''
let skillOptionsStamp = ''
let aiChats = []
let loadingChat = null
const aiTurns = new Map()
const aiDrafts = new Map()
const aiSending = new Set()

const checkedThreads = new Set()
let selectingThreads = false
function showThreadSelection() {
  byId('select-threads').textContent = selectingThreads ? 'Cancelar' : 'Selecionar'
  byId('select-threads').setAttribute('aria-pressed', String(selectingThreads))
  const remove = byId('delete-threads')
  remove.hidden = !selectingThreads
  remove.disabled = !checkedThreads.size
  remove.textContent = 'Apagar (' + checkedThreads.size + ')'
}
byId('select-threads').onclick = () => {
  selectingThreads = !selectingThreads
  checkedThreads.clear()
  renderAiChats()
}
byId('delete-threads').onclick = act(async () => {
  const threads = [...checkedThreads]
  if (threads.some(id => aiSending.has(id))) throw new Error('Aguarde a resposta nas conversas selecionadas.')
  if (!threads.length || !confirm('Apagar ' + threads.length + ' conversas selecionadas e suas memórias salvas?')) return
  await api('/api/ai/chats/delete', 'POST', { threads })
  if (threads.includes(selectedAiChat)) activateAiChat()
  for (const id of threads) { aiTurns.delete(id); aiDrafts.delete(id) }
  aiChats = aiChats.filter(chat => !checkedThreads.has(chat.id))
  checkedThreads.clear()
  selectingThreads = false
  renderAiChats()
  await refresh()
})

const divider = byId('sidebar-resize')
function setSidebarWidth(width) {
  const workbench = divider.parentElement
  const max = Math.max(180, Math.min(workbench.clientWidth - 280, 700))
  const value = Math.max(180, Math.min(width, max))
  workbench.style.setProperty('--sidebar-width', value + 'px')
  divider.setAttribute('aria-valuenow', String(value))
  divider.setAttribute('aria-valuemin', '180')
  divider.setAttribute('aria-valuemax', String(max))
  return value
}
divider.onpointerdown = event => { divider.setPointerCapture(event.pointerId); event.preventDefault() }
divider.onpointermove = event => {
  if (divider.hasPointerCapture(event.pointerId)) setSidebarWidth(event.clientX - divider.parentElement.getBoundingClientRect().left)
}
divider.onpointerup = () => localStorage.setItem('whatsia.sidebarWidth', divider.getAttribute('aria-valuenow'))
divider.onkeydown = event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const width = divider.previousElementSibling.offsetWidth + (event.key === 'ArrowLeft' ? -24 : 24)
  localStorage.setItem('whatsia.sidebarWidth', String(setSidebarWidth(width)))
}

function renderAiChats() {
  const stamp = JSON.stringify([selectedAiChat, aiChats, selectingThreads])
  if (stamp === aiChatStamp) return
  aiChatStamp = stamp
  for (const id of checkedThreads) if (!aiChats.some(chat => chat.id === id)) checkedThreads.delete(id)
  showThreadSelection()
  byId('ai-chats').replaceChildren(...aiChats.map(chat => {
    if (selectingThreads) {
      const row = element('label')
      row.className = 'thread-check'
      const checkbox = element('input')
      checkbox.type = 'checkbox'
      checkbox.checked = checkedThreads.has(chat.id)
      checkbox.onchange = () => {
        if (checkbox.checked) checkedThreads.add(chat.id)
        else checkedThreads.delete(chat.id)
        showThreadSelection()
      }
      row.append(checkbox, element('span', chat.title))
      return row
    }
    const node = button(chat.title, () => selectAiChat(chat), chat.id === selectedAiChat)
    node.title = chat.title
    node.classList.add('ai-chat-select')
    const row = element('div')
    row.className = 'ai-chat-row'
    const menu = element('details')
    menu.className = 'ai-chat-menu'
    const toggle = element('summary', '⋯')
    toggle.setAttribute('aria-label', 'Opções de ' + chat.title)
    const actions = element('div')
    actions.className = 'ai-chat-menu-actions'
    const rename = button('Renomear', () => { menu.open = false; manageAiChat(chat, false) })
    const remove = button('Apagar', () => { menu.open = false; manageAiChat(chat, true) })
    remove.className = 'danger-text'
    actions.append(rename, remove)
    menu.append(toggle, actions)
    row.append(node, menu)
    return row
  }))
}

const aiChatDialog = byId('ai-chat-dialog')
const aiChatForm = byId('ai-chat-form')
let editingAiChat = null
let deletingAiChat = false

function manageAiChat(chat, deleting) {
  editingAiChat = chat
  deletingAiChat = deleting
  byId('ai-chat-dialog-title').textContent = deleting ? 'Apagar conversa' : 'Renomear conversa'
  byId('ai-chat-confirm').textContent = 'Apagar «' + chat.title + '», incluindo as memórias salvas a partir desta conversa?'
  byId('ai-chat-confirm').hidden = !deleting
  byId('ai-chat-title-field').hidden = deleting
  aiChatForm.elements.title.disabled = deleting
  aiChatForm.elements.title.value = chat.title
  byId('ai-chat-error').textContent = ''
  const submit = byId('confirm-ai-chat')
  submit.textContent = deleting ? 'Apagar' : 'Salvar nome'
  submit.className = deleting ? 'danger-button' : 'ai-primary'
  aiChatDialog.showModal()
  if (deleting) byId('cancel-ai-chat').focus()
  else aiChatForm.elements.title.select()
}

byId('cancel-ai-chat').onclick = () => aiChatDialog.close()
aiChatForm.onsubmit = async event => {
  event.preventDefault()
  const chat = editingAiChat
  if (!chat) return
  const submit = byId('confirm-ai-chat')
  const url = '/api/ai/chats/' + pathPart(chat.id)
  submit.disabled = true
  byId('ai-chat-error').textContent = ''
  try {
    if (deletingAiChat) {
      await api(url, 'DELETE')
      aiChats = aiChats.filter(item => item.id !== chat.id)
      if (selectedAiChat === chat.id) activateAiChat()
      aiTurns.delete(chat.id)
      aiDrafts.delete(chat.id)
    } else {
      const result = await api(url, 'PATCH', { title: aiChatForm.elements.title.value })
      aiChats = aiChats.map(item => item.id === chat.id ? { ...item, title: result.title } : item)
      if (selectedAiChat === chat.id) byId('ai-thread-title').textContent = result.title
    }
    renderAiChats()
    aiChatDialog.close()
  } catch (failure) {
    byId('ai-chat-error').textContent = failure.message
  } finally {
    submit.disabled = false
  }
}

function renderDelivery(turn) {
  const draft = turn.delivery
  const card = element('div')
  card.className = 'ai-delivery'
  if (draft.status !== 'generated') card.append(element('strong', draft.status === 'sent' ? 'Mensagem enviada' : 'Rascunho de WhatsApp'),
    element('p', draft.accountName + ' → ' + draft.recipient))
  if (draft.quoted) {
    const quote = element('blockquote', draft.quotePreview || 'Mensagem citada')
    card.append(quote)
  }
  if (draft.image) {
    const preview = element('img')
    preview.className = 'ai-image-preview'
    preview.alt = 'Imagem gerada pela I.A.'
    preview.src = '/api/ai/deliveries/' + pathPart(turn.id) + '/image'
    preview.loading = 'lazy'
    const download = element('a', 'Baixar imagem')
    download.href = preview.src
    download.download = 'imagem-gerada.png'
    card.append(preview, element('small', 'Modelo: ' + draft.image.model), download)
  }
  const text = element('p', draft.body)
  text.className = 'delivery-text'
  card.append(text)
  if (draft.status === 'draft') {
    const submit = button('Enviar no WhatsApp', async () => {
      if (sendingDeliveries.has(turn.id)) return
      sendingDeliveries.add(turn.id)
      submit.disabled = true
      try {
        const result = await api('/api/ai/deliveries/' + pathPart(turn.id) + '/send', 'POST', {})
        turn.delivery = result.delivery
        turn.deliveryError = null
      } catch (failure) {
        turn.deliveryError = failure.message
        const saved = await api('/api/ai/chats/' + pathPart(thread)).catch(() => [])
        const delivery = saved.find(item => item.id === turn.id)?.delivery
        if (delivery) turn.delivery = delivery
      } finally {
        sendingDeliveries.delete(turn.id)
        if (selectedAiChat === thread) renderAiThread(true)
      }
    })
    const thread = selectedAiChat
    submit.disabled = sendingDeliveries.has(turn.id)
    card.append(submit)
  } else if (draft.status === 'sending' || draft.status === 'uncertain') {
    card.append(element('p', 'Envio em verificação. Confira a conversa no WhatsApp antes de repetir.'))
  }
  if (turn.deliveryError) card.append(element('p', turn.deliveryError))
  return card
}

function openAiReply(account, chat, message) {
  activateAiChat()
  selectedWhatsAppContext = chat
  selectedReplySource = message.id
  askForm.elements.account.value = account
  askForm.elements.scope.value = 'chat'
  askForm.elements.skill.value = 'builtin-whatsapp-send'
  askForm.elements.prompt.value = 'Responda: '
  show('ai')
  renderAiThread()
  updateAskScope()
  askForm.elements.prompt.focus()
  return refresh()
}

function renderLocalCommand(turn) {
  const command = turn.localCommand
  const section = element('section')
  section.append(element('pre', JSON.stringify(command.plan, null, 2)))
  const label = { running: 'Executando…', done: 'Execução concluída.', error: 'Falha na execução.',
    uncertain: 'O servidor reiniciou durante a execução. Confira o resultado antes de repetir.' }
  if (command.status === 'draft') {
    const execute = button('Executar no computador', async () => {
      execute.disabled = true
      try {
        const result = await api('/api/ai/local-commands/' + pathPart(turn.id) + '/execute', 'POST', { confirm: true })
        turn.localCommand = result.localCommand
        renderAiThread()
      } finally {
        execute.disabled = false
      }
    })
    section.append(execute)
  } else {
    section.append(element('p', label[command.status]))
  }
  if (command.error) section.append(element('p', command.error))
  for (const [title, output] of [['Saída', command.stdout], ['Erros', command.stderr]]) {
    if (output) section.append(element('strong', title), element('pre', output))
  }
  if (command.truncated) section.append(element('small', 'Saída truncada.'))
  return section
}

function renderAiThread(scroll = false) {
  const transcript = byId('ask-response')
  const turns = aiTurns.get(selectedAiChat) || []
  byId('ai-thread-title').textContent = aiChats.find(chat => chat.id === selectedAiChat)?.title || 'Nova conversa'
  askForm.querySelector('button[type=submit]').disabled = aiSending.has(selectedAiChat) || loadingChat === selectedAiChat
  if (!turns.length) {
    const intro = element('p', loadingChat === selectedAiChat ? 'Carregando conversa…' :
      'O que você quer consultar?')
    intro.className = 'ai-empty'
    transcript.replaceChildren(intro)
    return
  }
  const nodes = turns.flatMap(turn => {
    const prompt = element('div')
    prompt.className = 'ai-message ai-user'
    const bubble = element('p', turn.prompt)
    prompt.append(bubble)
    const answer = element('div')
    answer.className = 'ai-message ai-answer'
    if (turn.pending) {
      const status = element('span', turn.progress || 'Consultando os contextos…')
      status.setAttribute('role', 'status')
      answer.append(status)
    }
    else if (turn.error) answer.append(element('p', turn.error))
    else if (turn.answer) {
      const markdown = element('div')
      markdown.className = 'ai-markdown'
      markdown.append(renderMarkdown(turn.answer))
      answer.append(markdown)
      if (turn.waSkillId) answer.append(button('Abrir ação da skill',()=>openWhatsAppActions({skill:{id:turn.waSkillId,wa:true}})))
      const metadata = [turn.usage?.model && (turn.usage.provider === 'cloud' ? 'OpenAI · ' : 'Ollama · ') + turn.usage.model, turn.skillName && 'Skill: ' + turn.skillName, turn.remember && 'Salvo na memória'].filter(Boolean)
      if (metadata.length) answer.append(element('small', metadata.join(' · ')))
      const sources = element('div')
      sources.className = 'ai-sources'
      for (const source of turn.sources || []) sources.append(button(
        source.ref + ' · ' + source.conversation + (source.provenance ? ' · ' + source.provenance : ''), () => openChat(source.account, source.chat, source.source)
      ))
      if (sources.childElementCount) answer.append(sources)
      if (turn.delivery) answer.append(renderDelivery(turn))
      if (turn.localCommand) answer.append(renderLocalCommand(turn))
    } else return [prompt]
    return [prompt, answer]
  })
  transcript.replaceChildren(...nodes)
  if (scroll) transcript.scrollTop = transcript.scrollHeight
}

function activateAiChat(chat = null) {
  aiDrafts.set(selectedAiChat, askForm.elements.prompt.value)
  selectedAiChat = chat?.id || crypto.randomUUID()
  askForm.elements.prompt.value = aiDrafts.get(selectedAiChat) || ''
  askForm.elements.remember.checked = false
  askForm.elements.skill.value = ''
  selectedPerson = chat?.person ? { id: chat.person, label: chat.scopeLabel } : null
  selectedGroup = chat?.scope === 'group' ? { id: chat.chat, name: chat.scopeLabel } : null
  selectedWhatsAppContext = chat?.chat || null
  selectedReplySource = null
  const elements = askForm.elements
  if (chat?.account) elements.account.value = chat.account
  for (const [key, target] of [['person', selectedPerson], ['group', selectedGroup]]) {
    const option = elements.scope.querySelector('option[value=' + key + ']')
    option.hidden = !target
    if (target) option.textContent = chat.scopeLabel || (key === 'person' ? 'Pessoa selecionada' : 'Grupo selecionado')
  }
  elements.scope.value = chat?.scope || (chat?.person ? 'person' : chat?.chat ? 'chat' : !chat || chat.allAccounts ? 'accounts' : 'all')
  if (!elements.scope.value) elements.scope.value = 'all'
  updateAskScope()
  renderAiChats()
  renderAiThread(true)
}

async function selectAiChat(chat) {
  loadingChat = chat.id
  activateAiChat(chat)
  try {
    if (!aiSending.has(chat.id)) aiTurns.set(chat.id, await api('/api/ai/chats/' + pathPart(chat.id)))
  } finally {
    if (loadingChat === chat.id) loadingChat = null
    if (selectedAiChat === chat.id) renderAiThread(true)
  }
}
byId('new-ai-chat').onclick = () => {
  activateAiChat()
  askForm.elements.prompt.focus()
}

let conversationProvider
function updateAskScope() {
  const account = model.accounts.find(item => item.id === askForm.elements.account.value)
  const chatOption = askForm.elements.scope.options[1]
  const savedChat = aiChats.find(item => item.id === selectedAiChat)
  const savedContext = selectedWhatsAppContext && savedChat?.account === account?.id
  chatOption.disabled = !savedContext && (!model.chat || model.account !== account?.id)
  if (chatOption.disabled && askForm.elements.scope.value === 'chat') askForm.elements.scope.value = 'all'
  const labels = { auto: 'Ollama · OpenAI se o local estiver indisponível', local: 'Somente Ollama', cloud: 'OpenAI' }
  byId('ask-mode').textContent = account?.mode === 'off' ? 'IA desativada nesta conta' : (labels[conversationProvider] || '')
}
askForm.elements.scope.onchange = updateAskScope
askForm.elements.account.onchange = updateAskScope
askForm.onsubmit = async event => {
  event.preventDefault()
  const thread = selectedAiChat
  if (aiSending.has(thread) || loadingChat === thread) return
  const fields = askForm.elements
  const actionSkill = aiActionSkills.find(item => item.id === fields.skill.value)
  if (actionSkill) {
    try { await openWhatsAppActions({skill:actionSkill}) }
    catch (failure) { error(failure.message) }
    return
  }
  const prompt = fields.prompt.value.trim()
  if (!prompt) return
  const imagePrompt = searchText(prompt).replace(/^(?:por favor[, ]+|(?:voce )?pode |(?:eu )?quero (?:que (?:voce )?)?)/, '').trim()
  const imageRequest = /^(?:(?:gere|gerar|crie|criar|faca|fazer|produza|produzir|monte)\s+(?:(?:para|pra) mim\s+)?(?:(?:uma?|a|o)\s+)?(?:imagem|ilustracao|arte|desenho|foto|infografico|cartaz|logo|logotipo)\b|(?:desenhe|ilustre)\s+\S)/
  const wantsImage = imageRequest.test(imagePrompt) || /^(?:eu )?(?:quero|preciso de) (?:uma? )?(?:imagem|ilustracao|desenho|infografico)\b/.test(searchText(prompt))
  const generateImage = !fields.remember.checked && !fields.skill.value && wantsImage
  if (generateImage && /\b(?:envie|enviar|mande|mandar|encaminhe|encaminhar)\b/i.test(prompt)) {
    await openImageDraft().catch(failure => error(failure.message))
    return
  }
  const accountId = fields.account.value
  const scope = fields.scope.value
  const savedChat = aiChats.find(item => item.id === thread)
  const currentContext = (savedChat?.account === accountId || selectedReplySource) && selectedWhatsAppContext
    ? selectedWhatsAppContext : model.chat
  const remember = fields.remember.checked
  const includeDeleted = fields.includeDeleted.checked
  const replySource = scope === 'chat' ? selectedReplySource : null
  const requestId = crypto.randomUUID()
  const turn = { prompt, pending: true, progress: generateImage ? 'Gerando imagem…' : undefined }
  const labels = { 'consulting-chats': 'Consultando chats…', 'listing-groups': 'Consultando grupos…',
    'listing-contacts': 'Consultando contatos…', analyzing: 'Analisando as mensagens…' }
  let timer
  const pollProgress = async () => {
    try {
      const progress = await api(accountUrl(accountId) + '/ai/progress/' + pathPart(requestId))
      if (!turn.pending || progress?.phase === 'finished') return
      const label = progress?.phase === 'fetching-messages'
        ? 'Buscando mensagens na conversa ' + progress.current + ' de ' + progress.total + '…'
        : labels[progress?.phase]
      if (label && label !== turn.progress) {
        turn.progress = label
        if (selectedAiChat === thread) renderAiThread()
      }
    } catch {
      // The query can continue if progress is temporarily unavailable.
    }
    if (turn.pending) timer = setTimeout(pollProgress, 1000)
  }
  const turns = aiTurns.get(thread) || []
  turns.push(turn)
  aiTurns.set(thread, turns)
  aiSending.add(thread)
  fields.prompt.value = ''
  fields.remember.checked = false
  fields.includeDeleted.checked = false
  selectedReplySource = null
  renderAiThread(true)
  if (!generateImage) timer = setTimeout(pollProgress, 350)
  try {
    const result = generateImage ? await api(accountUrl(accountId) + '/ai/image', 'POST', { thread, prompt }) : await api(accountUrl(accountId) + '/ai/ask', 'POST', {
      thread, prompt, requestId, scope, conversationSettings: true, quoteSource: replySource, includeDeleted,
      scopeLabel: ['person', 'group'].includes(scope) ? fields.scope.selectedOptions[0]?.textContent : null,
      chat: scope === 'chat' ? currentContext : scope === 'group' ? selectedGroup?.id : null,
      person: scope === 'person' ? selectedPerson?.id : null,
      remember, autoSkills: fields.skill.value === '', skill: fields.skill.value === 'off' ? null : fields.skill.value || null,
      allAccounts: scope === 'accounts' || (scope === 'group' && model.accounts.find(account => account.id === accountId)?.mode === 'local')
    })
    Object.assign(turn, { id: result.entryId, answer: result.answer, sources: result.sources, usage: result.usage,
      skillName: result.skillName, remember: result.remembered, waSkillId: result.waSkillId, delivery: result.delivery, localCommand: result.localCommand })
  } catch (failure) {
    turn.error = failure.message
  } finally {
    turn.pending = false
    clearTimeout(timer)
    aiSending.delete(thread)
    if (selectedAiChat === thread) renderAiThread(true)
    await refresh().catch(failure => error(failure.message))
  }
}

const imageDialog = byId('image-dialog')
const imageForm = byId('image-form')
let imageDestinationAccount
async function openImageDraft() {
  const account = askForm.elements.account.value
  if (!account) throw new Error('Selecione a conta de destino.')
  imageDestinationAccount = account
  const submit = imageForm.querySelector('button[type=submit]')
  const status = byId('image-status')
  imageForm.reset()
  imageForm.elements.description.value = askForm.elements.prompt.value
  imageForm.elements.chat.replaceChildren(new Option('Carregando conversas…', ''))
  submit.disabled = true
  status.textContent = ''
  imageDialog.showModal()
  try {
    const chats = await api(accountUrl(account) + '/chats')
    if (!imageDialog.open || imageDestinationAccount !== account) return
    imageForm.elements.chat.replaceChildren(new Option('Selecione uma conversa', ''),
      ...chats.map(chat => new Option(chat.name, chat.id)))
    const preferred = askForm.elements.scope.value === 'group' ? selectedGroup?.id : selectedWhatsAppContext || model.chat
    if (preferred && chats.some(chat => chat.id === preferred)) imageForm.elements.chat.value = preferred
    submit.disabled = !chats.length
    if (!chats.length) status.textContent = 'Nenhuma conversa disponível nesta conta.'
  } catch (failure) {
    if (imageDialog.open) status.textContent = failure.message
  }
}
byId('image-close').onclick = () => imageDialog.close()
imageForm.onsubmit = async event => {
  event.preventDefault()
  const thread = selectedAiChat
  if (aiSending.has(thread)) return
  const fields = imageForm.elements
  const payload = { thread, chat: fields.chat.value, caption: fields.caption.value, prompt: fields.description.value.trim() }
  if (!payload.chat || !payload.prompt) return
  const account = imageDestinationAccount
  const turn = { prompt: payload.prompt, pending: true, progress: 'Gerando imagem…' }
  const turns = aiTurns.get(thread) || []
  turns.push(turn)
  aiTurns.set(thread, turns)
  aiSending.add(thread)
  imageDialog.close()
  renderAiThread(true)
  try {
    const result = await api(accountUrl(account) + '/ai/image', 'POST', payload)
    Object.assign(turn, { id: result.entryId, answer: result.answer, delivery: result.delivery })
  } catch (failure) {
    turn.error = failure.message
  } finally {
    turn.pending = false
    aiSending.delete(thread)
    if (selectedAiChat === thread) renderAiThread(true)
    await refresh().catch(failure => error(failure.message))
  }
}

askForm.elements.prompt.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    askForm.requestSubmit()
  }
}

const peopleDialog = byId('people-dialog')
const peopleForm = byId('people-form')
let people = []
let peopleStamp = ''
let editingPerson = null

function personName(person) {
  return person.profile.name || person.suggestedName || (person.id.endsWith('@c.us') ? '+' + person.id.split('@')[0] : 'Contato do WhatsApp')
}

function searchText(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

function directoryStamp(directory) {
  return JSON.stringify([model.account,model.accounts.map(a => [a.id,a.status]),directory])
}

function directoryProfile(sources, group = false) {
  const connected = sources.filter(s => model.accounts.some(a => a.id === s.account && a.status === 'Conectado'))
  const candidates = connected.length ? connected : sources
  const source = candidates.find(s => s.account === model.account) || candidates[0]
  return {...source, group}
}

function directoryRow(name, detail, actions, profile) {
  const row = element('details')
  row.className = 'directory-row'
  const header = element('summary')
  if (profile) {
    row.classList.add('directory-profile')
    const label = element('span')
    label.className = 'directory-identity'
    const about = element('span')
    about.className = 'directory-about'
    label.append(element('strong', name),about)
    header.append(chatAvatar(profile.account,{id:profile.peer,name,group:profile.group},true),label,element('small',detail))
    if (profile.account && profile.peer) {
      header.dataset.about = chatUrl(profile.account,profile.peer) + '/about'
      const saved = directoryAbout.get(header.dataset.about)
      if (saved) about.textContent = about.title = saved.text
      if (!saved || saved.until < Date.now()) avatarObserver.observe(header)
    }
  } else header.append(element('strong', name), element('small', detail))
  const tools = element('div')
  tools.className = 'row-actions'
  tools.append(...actions)
  row.append(header, tools)
  return row
}

function renderPeople() {
  clearProfileObservers(byId('people-list'))
  const query = searchText(byId('people-search').value)
  const matching = people.filter(person => [personName(person), person.id, ...Object.values(person.profile)]
    .some(value => searchText(value).includes(query)))
  const items = matching.map(person => {
    const accounts = person.accounts.map(id => model.accounts.find(account => account.id === id)?.name).filter(Boolean)
    return directoryRow(personName(person), [person.profile.organization, person.profile.relationship, ...accounts].filter(Boolean).join(' · '),
      [button('Ver perfil', () => editPerson(person)), button('Consultar na I.A.', () => askPerson(person))], directoryProfile(person.profileSources || []))
  })
  byId('people-list').replaceChildren(...(items.length ? items : [element('p', 'Nenhuma pessoa encontrada.')]))
}

function askPerson(person) {
  activateAiChat()
  selectedPerson = person
  const option = askForm.elements.scope.querySelector('option[value=person]')
  option.hidden = false
  option.textContent = 'Pessoa: ' + personName(person)
  askForm.elements.scope.value = 'person'
  const account = model.accounts.find(item => person.accounts.includes(item.id) && item.mode !== 'off')
  if (account) askForm.elements.account.value = account.id
  show('ai')
  askForm.elements.prompt.focus()
  return refresh()
}

function editPerson(person = null) {
  editingPerson = person?.id || null
  byId('people-title').textContent = person ? personName(person) : 'Cadastrar pessoa'
  byId('person-notice').textContent = ''
  for (const field of ['name', 'relationship', 'organization', 'responsibilities', 'personalTopics', 'companyTopics', 'instructions']) {
    peopleForm.elements[field].value = person?.profile[field] || ''
  }
  peopleForm.elements.name.placeholder = person?.suggestedName || ''
  peopleForm.elements.phone.value = person?.id.endsWith('@c.us') ? '+' + person.id.split('@')[0] : ''
  peopleForm.elements.phone.readOnly = Boolean(person?.id.endsWith('@c.us'))
  peopleForm.elements.phone.required = !person
  const sources = byId('person-sources')
  sources.replaceChildren()
  if (person?.chats.length) {
    sources.append(element('h3', 'Conversas'))
    for (const chat of person.chats) {
      const account = model.accounts.find(item => item.id === chat.account)?.name
      sources.append(button([chat.title, account].filter(Boolean).join(' · '), () => {
        peopleDialog.close()
        return openChat(chat.account, chat.chat)
      }))
    }
  }
  if (person?.observations.length) {
    sources.append(element('h3', 'Observações da I.A.'))
    for (const observation of [...person.observations].reverse()) {
      const entry = element('p', observation.text + ' ')
      entry.append(button('Ver mensagem', () => {
        peopleDialog.close()
        return openChat(observation.account, observation.chat, observation.source)
      }))
      sources.append(entry)
    }
  }
  peopleDialog.showModal()
}

peopleForm.onsubmit = async event => {
  event.preventDefault()
  const submit = peopleForm.querySelector('button[type=submit]')
  submit.disabled = true
  try {
    await api('/api/people', 'POST', { ...Object.fromEntries(new FormData(peopleForm)), id: editingPerson })
    peopleDialog.close()
    people = await api('/api/people')
    peopleStamp = directoryStamp(people)
    renderPeople()
  } catch (failure) {
    byId('person-notice').textContent = failure.message
  } finally {
    submit.disabled = false
  }
}
byId('people-search').oninput = renderPeople
byId('add-person').onclick = () => editPerson()
byId('close-person').onclick = () => peopleDialog.close()
byId('people-tab').onclick = act(async () => { show('people'); await refresh() })

const groupDialog = byId('group-dialog')
const groupForm = byId('group-form')
let groupList = []
let groupStamp = ''
let editingGroup = null
const bulkDialog = byId('bulk-dialog')
const bulkForm = byId('bulk-form')
let bulkGroup = null
let bulkTimer
let bulkStarting = false

function renderGroups() {
  clearProfileObservers(byId('groups-list'))
  const search = searchText(byId('groups-search').value)
  const groups = groupList.filter(group => [group.name, ...group.accounts.map(account => account.name)]
    .some(value => searchText(value).includes(search)))
  const cards = groups.map(group => {
    return directoryRow(group.name, group.accounts.map(account => account.name).join(' · '),
      [button('Participantes', () => openWhatsAppActions({account:(group.accounts.find(a=>a.connected) || group.accounts[0]).id,chat:group.id,operation:'group.participants',inspect:true})),button('Ver contexto', () => editGroup(group)), button('Processar histórico', () => openBulk(group)), button('Consultar na I.A.', () => askGroup(group))], directoryProfile(group.accounts.map(a=>({account:a.id,peer:group.id})),true))
  })
  byId('groups-list').replaceChildren(...(cards.length ? cards : [element('p', 'Nenhum grupo encontrado.')]))
}

function editGroup(group) {
  editingGroup = group.id
  byId('group-title').textContent = group.name
  const notice = byId('group-error')
  notice.textContent = ''
  for (const name of ['name', 'purpose', 'responsibilities', 'instructions']) groupForm.elements[name].value = group.profile[name] || ''
  const accountCards = group.accounts.map(account => {
    const card = element('article')
    card.append(element('strong', account.name), element('p', account.history?.summary || 'Histórico ainda não processado.'))
    if (account.connected) card.append(button('Abrir conversa', () => {
      groupDialog.close()
      return openChat(account.id, group.id)
    }))
    return card
  })
  byId('group-accounts').replaceChildren(...accountCards)
  groupDialog.showModal()
}

function askGroup(group) {
  activateAiChat()
  selectedGroup = group
  const option = askForm.elements.scope.querySelector('option[value=group]')
  option.hidden = false
  option.textContent = 'Grupo: ' + group.name
  askForm.elements.scope.value = 'group'
  const account = group.accounts.find(account => account.mode === 'local') ||
    group.accounts.find(account => account.mode === 'cloud')
  if (account) askForm.elements.account.value = account.id
  show('ai')
  askForm.elements.prompt.focus()
  return refresh()
}

async function pollBulk() {
  try {
    const job = await api('/api/history/bulk')
    if (!bulkDialog.open || bulkStarting) return
    const active = ['listing', 'processing', 'waiting'].includes(job?.status)
    bulkForm.querySelector('button[type=submit]').disabled = active || job?.status === 'paused'
    let status = job ? job.completed + ' de ' + job.total + ' conversas · ' + job.messages + ' mensagens acrescentadas' : ''
    if (job?.status === 'listing') status = 'Carregando as conversas disponíveis…'
    if (job?.status === 'waiting') status += ' · Aguardando contas ou conversas'
    if (job?.status === 'paused') status += ' · Pausado'
    if (job?.status === 'canceled') status += ' · Cancelado'
    if (job?.current) status += ' · ' + job.current.label + ' (' + (job.current.job.processed || job.current.job.loaded) + ' mensagens)'
    if (job?.status === 'done') status += ' · ' + job.unchanged + ' sem texto novo · ' + job.errors.length + ' com erro'
    if (job?.transcriptionErrors) status += ' · ' + job.transcriptionErrors + ' áudios sem transcrição'
    if (job?.mediaErrors) status += ' · ' + job.mediaErrors + ' imagens ou PDFs com falha'
    if (job?.skippedAccounts.length) status += ' · Contas aguardando: ' + job.skippedAccounts.join(', ')
    byId('bulk-status').textContent = status
    byId('bulk-errors').replaceChildren(...(job?.errors || []).map(item => element('li', item.label + ' · ' + item.message)))
    const controls = byId('bulk-controls')
    const control = (label, endpoint, action) => button(label, async () => {
      clearTimeout(bulkTimer)
      try { await api('/api/history/bulk/' + endpoint, 'POST', { id: job.id, action }) }
      finally { await pollBulk() }
    })
    controls.replaceChildren()
    if (active && !job.pauseRequested && !job.stopRequested) controls.append(control('Pausar', 'control', 'pause'))
    if (job?.status === 'paused') controls.append(control('Retomar', 'control', 'resume'))
    if ((active || job?.status === 'paused') && !job.stopRequested) controls.append(control('Cancelar', 'cancel'))
    if (!active && job?.status !== 'paused' && job?.errors?.some(item => item.chat)) controls.append(control('Tentar conversas com erro', 'retry'))
    if (active) bulkTimer = setTimeout(pollBulk, 1800)
  } catch (failure) {
    if (bulkDialog.open) byId('bulk-status').textContent = failure.message
  }
}

function openBulk(group = null) {
  bulkGroup = group?.id || null
  byId('bulk-title').textContent = group ? 'Processar grupo: ' + group.name : 'Processar histórico de todas as conversas'
  byId('bulk-status').textContent = ''
  byId('bulk-errors').replaceChildren()
  bulkDialog.showModal()
  return pollBulk()
}

bulkForm.onsubmit = async event => {
  event.preventDefault()
  const submit = bulkForm.querySelector('button[type=submit]')
  submit.disabled = true
  bulkStarting = true
  clearTimeout(bulkTimer)
  try {
    await api('/api/history/bulk', 'POST', { days: Number(bulkForm.elements.days.value), group: bulkGroup })
    bulkStarting = false
    await pollBulk()
  } catch (failure) {
    byId('bulk-status').textContent = failure.message
    submit.disabled = false
  } finally {
    bulkStarting = false
  }
}
groupForm.onsubmit = async event => {
  event.preventDefault()
  const submit = groupForm.querySelector('button[type=submit]')
  submit.disabled = true
  try {
    await api('/api/groups/' + pathPart(editingGroup), 'PATCH', Object.fromEntries(new FormData(groupForm)))
    groupDialog.close()
    await refresh()
  } catch (failure) {
    byId('group-error').textContent = failure.message
  } finally {
    submit.disabled = false
  }
}
byId('groups-tab').onclick = act(async () => { show('groups'); await refresh() })
byId('groups-search').oninput = renderGroups
byId('close-group').onclick = () => groupDialog.close()
byId('bulk-history').onclick = act(() => openBulk())
byId('close-bulk').onclick = () => bulkDialog.close()
bulkDialog.onclose = () => clearTimeout(bulkTimer)

let listedSkills = []
let skillsStamp = ''
const skillForm = byId('skill-form')
const skillNotice = byId('skill-notice')
let editingSkill = null

function editSkill(skill = null, description = '') {
  editingSkill = skill?.id || null
  skillForm.elements.name.value = skill?.name || ''
  skillForm.elements.description.value = skill?.description || description
  byId('skill-form-title').textContent = skill ? 'Editar skill' : 'Nova skill'
  skillNotice.textContent = ''
  skillForm.hidden = false
  skillForm.elements.name.focus()
}

function renderSkills(skills) {
  listedSkills = skills
  const query = searchText(byId('skill-search').value)
  const stamp = JSON.stringify([skills, query])
  if (stamp === skillsStamp) return
  skillsStamp = stamp
  const cards = skills.filter(skill => searchText(skill.name + ' ' + skill.description).includes(query)).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')).map(skill => {
    const toggle = element('input')
    toggle.type = 'checkbox'
    toggle.checked = skill.active
    toggle.setAttribute('aria-label', 'Skill ativa · ' + skill.name)
    const label = element('label')
    label.className = 'skill-toggle'
    label.append(toggle, ' Skill ativa')
    toggle.onchange = async () => {
      toggle.disabled = true
      try {
        await api('/api/ai/skills/' + pathPart(skill.id), 'PATCH', { active: toggle.checked })
        renderSkills(await api('/api/ai/skills'))
        await refresh()
      } catch (failure) {
        toggle.checked = skill.active
        skillNotice.textContent = failure.message
      } finally {
        toggle.disabled = false
      }
    }
    const card = directoryRow(skill.name, skill.active ? 'Ativa' : 'Inativa', [element('p', skill.description), label])
    if (skill.dependencyNames?.length) card.append(element('p', 'Usa ' + skill.dependencyNames.join(', ')))
    if (skill.dependencyError) card.append(element('p', skill.dependencyError))
    if (skill.wa) {
      card.append(button('Executar ação', () => openWhatsAppActions({skill})),
        button('Editar ação', () => openWhatsAppActions({skill, saving:true})))
    } else if (!skill.builtin) card.append(button('Editar', () => editSkill(skill)))
    return card
  })
  byId('skills-list').replaceChildren(...(cards.length ? cards : [element('p', 'Nenhuma skill criada.')]))
}

let skillProposalStamp = ''
function renderSkillProposals(proposals) {
  const stamp = JSON.stringify(proposals)
  if (stamp === skillProposalStamp) return
  skillProposalStamp = stamp
  const area = byId('skill-proposals')
  area.hidden = !proposals.length
  area.replaceChildren(element('h3', 'Skills aguardando aprovação'), ...proposals.map(proposal => {
    const card = element('article')
    const description = element('p', proposal.description)
    description.style.whiteSpace = 'pre-wrap'
    const decide = action => async () => {
      try {
        const result = await api('/api/ai/skill-proposals/' + pathPart(proposal.code), 'PATCH', { action })
        skillNotice.textContent = result.answer
        await refresh()
        renderSkills(await api('/api/ai/skills'))
      } catch (failure) {
        skillNotice.textContent = failure.message
      }
    }
    card.append(element('strong', proposal.name), description,
      button('Aprovar e ativar', decide('approve')), button('Recusar', decide('reject')))
    return card
  }))
}

byId('skills-tab').onclick = act(async () => { show('skills'); await refresh() })
byId('skill-search').oninput = () => renderSkills(listedSkills)
byId('new-skill').onclick = () => editSkill()
byId('cancel-skill').onclick = () => {
  skillForm.hidden = true
  skillNotice.textContent = ''
}
skillForm.onsubmit = async event => {
  event.preventDefault()
  const submit = skillForm.querySelector('button[type=submit]')
  const id = editingSkill
  submit.disabled = true
  skillNotice.textContent = ''
  try {
    const fields = skillForm.elements
    await api('/api/ai/skills' + (id ? '/' + pathPart(id) : ''), id ? 'PATCH' : 'POST', {
      name: fields.name.value, description: fields.description.value
    })
    skillForm.hidden = true
    skillNotice.textContent = id ? 'Skill atualizada.' : 'Skill criada.'
    renderSkills(await api('/api/ai/skills'))
    await refresh()
  } catch (failure) {
    skillNotice.textContent = failure.message
  } finally {
    submit.disabled = false
  }
}

async function editContext(account, chat, title) {
  const url = chatUrl(account, chat) + '/context'
  const data = await api(url)
  const dialog = byId('context-dialog')
  const form = byId('context-form')
  const notice = byId('context-error')
  byId('context-chat').textContent = title
  notice.hidden = true
  for (const field of ['purpose', 'participants', 'vocabulary', 'priorities']) {
    form.elements[field].value = data.profile[field] || ''
  }
  const memory = byId('context-memory')
  const facts = [...data.memory].reverse().map(fact => {
    const item = element('li', fact.text + ' ')
    item.append(button('Ver origem', () => {
      dialog.close()
      return openChat(account, chat, fact.source)
    }))
    return item
  })
  memory.replaceChildren(...(facts.length ? facts : [element('li', 'Nenhum fato recente registrado.')]))
  form.onsubmit = async event => {
    event.preventDefault()
    const submit = form.querySelector('button:not([type])')
    submit.disabled = true
    notice.hidden = true
    try {
      await api(url, 'PATCH', Object.fromEntries(new FormData(form)))
      dialog.close()
    } catch (failure) {
      notice.textContent = failure.message
      notice.hidden = false
    } finally {
      submit.disabled = false
    }
  }
  activeContext = url
  const mode = model.accounts.find(item => item.id === account)?.mode
  byId('history-mode').textContent = mode === 'cloud'
    ? 'Modo híbrido. O texto do período selecionado será enviado à OpenAI.'
    : 'Usa o texto disponível no WhatsApp e transcreve áudios com o Whisper local configurado.'
  dialog.showModal()
  if (showHistory(data)) historyTimer = setTimeout(() => pollHistory(url), 2000)
}
byId('context-dialog').onclose = () => {
  activeContext = null
  clearTimeout(historyTimer)
}
byId('close-context').onclick = () => byId('context-dialog').close()

const archiveDialog = byId('archive-dialog')
const archiveFilter = byId('archive-filter')
const archiveSettings = byId('archive-settings-dialog')
const archiveSettingsForm = byId('archive-settings-form')
const archiveStates = { complete: 'Cópia completa', 'text-only': 'Somente texto', unavailable: 'Conteúdo indisponível' }
let archivePage = 0
let appliedArchive = new URLSearchParams()
let archiveSettingsUrl
let archiveRequest = 0

function archiveReveal(account, chat, id) {
  const details = element('details')
  const content = element('div')
  details.append(element('summary', 'Mostrar conteúdo apagado'), content)
  const url = chatUrl(account, chat) + '/deleted/' + pathPart(id)
  async function load() {
    content.replaceChildren(element('p', 'Consultando cópia local…'))
    try {
      const saved = await api(url)
      content.replaceChildren(element('small', archiveStates[saved.availability] || 'Cópia local'))
      if (saved.body) content.append(element('p', saved.body))
      if (saved.media) {
        if (saved.previewType) {
          const type = saved.previewType.split('/')[0]
          const preview = element(type === 'image' ? 'img' : type)
          preview.className = 'archive-preview'
          preview.src = url + '/media?preview=1'
          if (type === 'image') preview.alt = 'Mídia preservada no arquivo local'
          else { preview.controls = true; preview.preload = 'metadata' }
          content.append(preview)
        }
        const download = element('a', 'Baixar mídia salva')
        download.href = url + '/media'
        content.append(download)
      } else if (saved.pending || saved.hasMedia || saved.issue) {
        content.append(element('p', saved.pending ? 'A mídia ainda está na fila.' : saved.issue || 'A mídia não foi capturada.'))
        if (!saved.pending && saved.hasMedia) content.append(button('Tentar recuperar mídia', async () => {
          try { await api(url + '/retry', 'POST', {}); await load() }
          catch (failure) { content.append(element('p', failure.message)) }
        }))
        if (saved.pending) content.append(button('Atualizar', load))
      }
    } catch (failure) { content.replaceChildren(element('p', failure.message)) }
  }
  details.ontoggle = () => { if (details.open) load() }
  return details
}

async function editArchiveSettings(account, chat) {
  archiveSettingsUrl = chatUrl(account, chat) + '/archive-settings'
  const settings = await api(archiveSettingsUrl)
  const fields = archiveSettingsForm.elements
  fields.enabled.checked = settings.enabled
  fields.textDays.value = settings.textDays
  byId('archive-settings-status').textContent = ''
  archiveSettings.showModal()
}
byId('archive-settings-close').onclick = () => archiveSettings.close()
archiveSettingsForm.onsubmit = async event => {
  event.preventDefault()
  const fields = archiveSettingsForm.elements
  const status = byId('archive-settings-status')
  try {
    await api(archiveSettingsUrl, 'PATCH', { enabled: fields.enabled.checked,
      textDays: Number(fields.textDays.value) })
    archiveSettings.close()
  } catch (failure) { status.textContent = failure.message }
}

function applyArchiveFilters() {
  const fields = archiveFilter.elements
  if (fields.start.value && fields.end.value && fields.start.value > fields.end.value) {
    byId('archive-feedback').textContent = 'A data inicial deve ser anterior ou igual à final.'
    return
  }
  archivePage = 0
  appliedArchive = new URLSearchParams(new FormData(archiveFilter))
  return loadArchive()
}

async function loadArchive() {
  const sequence = ++archiveRequest
  const query = new URLSearchParams(appliedArchive)
  const activity = query.get('view') === 'activity'
  query.delete('view')
  if (!activity) query.delete('kind')
  query.set('offset', archivePage * 20)
  const feedback = byId('archive-feedback')
  const results = byId('archive-results')
  results.setAttribute('aria-busy', 'true')
  feedback.textContent = 'Consultando…'
  byId('archive-prev').disabled = true
  byId('archive-next').disabled = true
  try {
    const [result, usage] = await Promise.all([
      api((activity ? '/api/activity?' : '/api/archive/deleted?') + query),
      api('/api/archive/usage?' + new URLSearchParams({ account: query.get('account') || '' })).catch(() => null)
    ])
    if (archiveRequest !== sequence) return
    if (usage) byId('archive-usage').textContent = usage.messages + ' cópias · ' +
      new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(usage.bytes / 1048576) + ' MiB'
    const names = { archived: 'Arquivada', deleted: 'Apagada', sent: 'Enviada', corrected: 'Corrigida', transcribed: 'Transcrita' }
    const items = activity ? result.events : result.entries
    feedback.textContent = activity ? items.length + ' registros exibidos' : result.total + ' mensagens encontradas'
    byId('archive-page').textContent = !activity && result.total ? 'Página ' + (archivePage + 1) + ' de ' + Math.ceil(result.total / 20) : ''
    const empty = element('p', activity ? 'Nenhuma atividade com esses filtros.' : 'Nenhuma mensagem apagada com esses filtros.')
    empty.className = 'archive-empty'
    results.replaceChildren(...(items.length ? [] : [empty]), ...items.map(item => {
      const row = element('article')
      row.append(element('strong', item.title || names[item.kind] || item.chat),
        element('small', [model.accounts.find(account => account.id === item.account)?.name,
          new Date(item.timestamp).toLocaleString('pt-BR'), archiveStates[item.availability]].filter(Boolean).join(' · ')))
      if (activity) {
        if (item.chat) row.append(button(item.source ? 'Abrir origem' : 'Abrir conversa', () => {
          archiveDialog.close()
          return openChat(item.account, item.chat, item.source)
        }))
      } else {
        row.append(archiveReveal(item.account, item.chat, item.id), button('Abrir conversa', () => {
          archiveDialog.close()
          return openChat(item.account, item.chat, item.id)
        }))
      }
      return row
    }))
    byId('archive-prev').disabled = activity || archivePage === 0
    byId('archive-next').disabled = activity || (archivePage + 1) * 20 >= result.total
  } catch (failure) {
    if (archiveRequest === sequence) {
      results.replaceChildren()
      feedback.textContent = failure.message
    }
  } finally {
    if (archiveRequest === sequence) results.removeAttribute('aria-busy')
  }
}

function openArchive(account = '', chat = '') {
  const fields = archiveFilter.elements
  fields.account.replaceChildren(new Option('Todas', ''),
    ...model.accounts.map(item => new Option(item.name, item.id)))
  if (account) {
    archiveFilter.reset()
    fields.account.value = account
    fields.chat.value = chat
  }
  byId('archive-kind').hidden = fields.view.value !== 'activity'
  archiveDialog.showModal()
  return applyArchiveFilters()
}

byId('archive-open').onclick = act(() => openArchive())
archiveFilter.onsubmit = act(applyArchiveFilters)
archiveFilter.elements.view.onchange = act(() => {
  byId('archive-kind').hidden = archiveFilter.elements.view.value !== 'activity'
  return applyArchiveFilters()
})
byId('archive-clear').onclick = act(() => {
  const view = archiveFilter.elements.view.value
  archiveFilter.reset()
  archiveFilter.elements.view.value = view
  return applyArchiveFilters()
})
byId('archive-close').onclick = () => archiveDialog.close()
byId('archive-prev').onclick = act(async () => { archivePage--; await loadArchive() })
byId('archive-next').onclick = act(async () => { archivePage++; await loadArchive() })

const chatSearch = byId('chat-search')
const chatFilter = byId('chat-filter')
let chatDirectoryStamp = ''
let chatHeadingStamp = ''
const knownAvatars = new Set()
const directoryAbout = new Map()
const waitingAvatars = new Set()
function clearProfileObservers(container) {
  for (const node of container.querySelectorAll('[data-src],[data-about]')) {
    avatarObserver.unobserve(node)
    waitingAvatars.delete(node)
  }
}
let activeAvatars = 0
function loadVisibleAvatars() {
  for (const photo of waitingAvatars) {
    if (activeAvatars >= 4) break
    waitingAvatars.delete(photo)
    if (!photo.isConnected) continue
    avatarObserver.unobserve(photo)
    activeAvatars++
    const finish = () => { activeAvatars--; loadVisibleAvatars() }
    if (photo.dataset.about) {
      const url = photo.dataset.about
      api(url).then(({text})=>{
        directoryAbout.set(url,{text,until:Date.now() + (text ? 300000 : 60000)})
        const about = photo.querySelector('.directory-about')
        if (about) about.textContent = about.title = text
      }).catch(()=>{}).finally(finish)
    } else {
      photo.onload = () => {knownAvatars.add(photo.dataset.src);finish()}
      photo.onerror = () => {knownAvatars.delete(photo.dataset.src);photo.remove();finish()}
      photo.loading = 'eager'
      photo.src = photo.dataset.src
    }
  }
}
const avatarObserver = new IntersectionObserver(entries => {
  for (const entry of entries) {
    if (entry.isIntersecting && entry.target.isConnected) waitingAvatars.add(entry.target)
    else waitingAvatars.delete(entry.target)
  }
  loadVisibleAvatars()
}, { rootMargin: '80px 0px' })

function chatAvatar(account, chat, inList = false) {
  const avatar = element('span', (chat.name || '?').trim().split(/\s+/).slice(0, 2)
    .map(word => Array.from(word)[0]).join('').toUpperCase() || '?')
  avatar.className = 'chat-avatar' + (chat.group ? ' chat-avatar-group' : '')
  avatar.setAttribute('aria-hidden', 'true')
  if (!account || !chat.id) return avatar
  const photo = element('img')
  photo.alt = ''
  photo.loading = 'lazy'
  photo.decoding = 'async'
  const url = chatUrl(account, chat.id) + '/avatar?v=2'
  photo.fetchPriority = 'low'
  if (inList && !knownAvatars.has(url)) {
    photo.dataset.src = url
    avatarObserver.observe(photo)
  } else {
    photo.onload = () => knownAvatars.add(url)
    photo.onerror = () => {knownAvatars.delete(url);photo.remove()}
    photo.src = url
  }
  avatar.append(photo)
  return avatar
}

function chatTime(timestamp) {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  if (date.toDateString() === new Date().toDateString()) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
  }
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
}

function chatPreview(preview) {
  if (!preview) return ''
  const labels = { image: 'Foto', ptt: 'Áudio', audio: 'Áudio', video: 'Vídeo', document: 'Documento',
    sticker: 'Figurinha', revoked: 'Mensagem apagada' }
  if (preview.type === 'revoked') return labels.revoked
  const text = preview.type === 'chat' ? preview.text : [labels[preview.type], preview.text].filter(Boolean).join(' · ')
  return text ? (preview.fromMe ? 'Você: ' : '') + text : ''
}

function chatListPreview(preview) {
  const node = element('span')
  node.className = 'chat-row-preview'
  if (!preview) return node
  const paths = {
    image: 'M3 4h18v16H3z M3 17l6-6 4 4 3-3 5 5 M15 8h.01',
    audio: 'M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0z M5 11v1a7 7 0 0 0 14 0v-1 M12 19v3 M8 22h8',
    video: 'M3 6h12v12H3z M15 10l6-4v12l-6-4',
    document: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h6'
  }
  const types = { image: 'image', sticker: 'image', ptt: 'audio', audio: 'audio', video: 'video', document: 'document', file: 'document' }
  const type = types[preview.type] || (preview.media ? 'document' : null)
  if (!type) {
    if (preview.type === 'chat' && preview.text) {
      if (preview.fromMe) node.append('Você: ')
      node.append(Array.isArray(preview.styles) ? renderWhatsAppPreview(document,preview) :
        formatWhatsApp(document, preview.text, { preview: true }))
    } else node.textContent = chatPreview(preview)
    return node
  }
  const label = { image: 'Imagem', audio: 'Áudio', video: 'Vídeo', document: 'Arquivo' }[type]
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('role', 'img')
  svg.setAttribute('aria-label', label)
  const path = document.createElementNS(svg.namespaceURI, 'path')
  path.setAttribute('d', paths[type])
  svg.append(path)
  node.title = label
  node.append(svg)
  return node
}

const chatAccountScope = byId('chat-account-scope')
let chatScopeOptions = ''
function renderChatScope() {
  const stamp = JSON.stringify(model.accounts.map(item => [item.id, item.name]))
  if (stamp !== chatScopeOptions) {
    chatScopeOptions = stamp
    chatAccountScope.replaceChildren(new Option('Todas as contas', 'all'),
      ...model.accounts.map(item => new Option(item.name, item.id)))
  }
  chatAccountScope.value = model.chatScope || model.account || 'all'
}

chatAccountScope.onchange = act(async () => {
  directoryLimit = 50
  model.chatScope = chatAccountScope.value
  chatDirectoryStamp = ''
  if (model.chatScope !== 'all' && model.chatScope !== model.account) return openChat(model.chatScope, null)
  await refresh()
})
let directoryLimit = 50
function resetDirectoryLimit() { directoryLimit = 50; renderChatDirectory() }
chatSearch.oninput = resetDirectoryLimit
const filterChips = byId('mobile-chat-filters')
for (const option of chatFilter.options) {
  const chip = button(option.text, () => {
    chatFilter.value = option.value
    chatFilter.onchange()
  })
  chip.dataset.value = option.value
  filterChips.append(chip)
}
function syncChatFilters() {
  for (const chip of filterChips.children) chip.setAttribute('aria-pressed',String(chip.dataset.value === chatFilter.value))
}
chatFilter.onchange = () => { syncChatFilters(); resetDirectoryLimit() }
syncChatFilters()

function renderChatDirectory() {
  const search = filterKey(chatSearch.value.trim())
  const filter = chatFilter.value
  const combined = model.chatScope === 'all'
  const matching = model.chats.filter(chat => (combined || chat.accountId === model.chatScope) &&
    (!search || filterKey(chat.name || chat.id).includes(search)) &&
    (filter === 'all' || (filter === 'unread' && chat.unread > 0) || (filter === 'groups' && chat.group)))
  const visible = matching.slice(0, directoryLimit)
  const directoryStamp = JSON.stringify([model.chatScope, model.account, model.chat, visible, matching.length, model.accounts.map(item => item.status === 'Conectado')])
  if (directoryStamp !== chatDirectoryStamp) {
    chatDirectoryStamp = directoryStamp
    clearProfileObservers(byId('chats'))
    byId('chats').replaceChildren(...visible.map(chat => {
      const selected = model.account === chat.accountId && model.chat === chat.id
      const row = button('', () => openChat(chat.accountId, chat.id), selected)
      row.dataset.chat = chat.id
      row.dataset.account = chat.accountId
      row.classList.add('chat-row')
      const body = element('span')
      body.className = 'chat-row-body'
      const title = element('strong', chat.name)
      const preview = chatListPreview(chat.preview)
      body.append(title, preview)
      if (combined) {
        const source = element('span', chat.accountName)
        source.className = 'chat-account-label'
        body.append(source)
      }
      const meta = element('span')
      meta.className = 'chat-row-meta'
      meta.append(element('time', chatTime(chat.timestamp)))
      if (chat.unread > 0) {
        const badge = element('span', chat.unread > 99 ? '99+' : String(chat.unread))
        badge.className = 'chat-unread'
        badge.setAttribute('aria-label', chat.unread + ' mensagens não lidas')
        meta.append(badge)
      }
      row.setAttribute('aria-current', selected ? 'true' : 'false')
      row.append(chatAvatar(chat.accountId, chat, true), body, meta)
      return row
    }))
    if (visible.length < matching.length) byId('chats').append(button('Mostrar mais conversas (' + (matching.length - visible.length) + ')', () => {
      directoryLimit += 50
      renderChatDirectory()
    }))
    if (!matching.length) byId('chats').append(element('p', model.chats.length
      ? 'Nenhuma conversa encontrada.' : 'O WhatsApp ainda não retornou conversas para esta conta.'))
  }
}

function mediaNote(id, label, text) {
  const note = element('button', text)
  note.type = 'button'
  note.className = 'media-note'
  note.setAttribute('aria-description', label)
  const expanded = historyWindow.expandedMedia
  const key = JSON.stringify([id, label])
  note.setAttribute('aria-expanded', String(expanded.has(key)))
  note.onclick = () => {
    if (expanded.has(key)) expanded.delete(key)
    else expanded.add(key)
    note.setAttribute('aria-expanded', String(expanded.has(key)))
  }
  return note
}

const chatCalendarDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' })
const chatClock = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function renderReceipt(time, ack) {
  const level = [1,2,3,4].includes(ack) ? Math.min(ack,3) : 0
  const previous = time.querySelector('.message-ack')
  if (Number(previous?.dataset.level || 0) === level) return
  previous?.remove()
  if (!level) return
  const label = ['','Enviada','Entregue','Lida'][level]
  const badge = element('span')
  badge.className = 'message-ack'
  badge.dataset.level = String(level)
  badge.title = label
  badge.setAttribute('role','img')
  badge.setAttribute('aria-label',label)
  const svg = document.createElementNS('http://www.w3.org/2000/svg','svg')
  svg.setAttribute('viewBox','0 0 20 14')
  svg.setAttribute('aria-hidden','true')
  const path = document.createElementNS(svg.namespaceURI,'path')
  path.setAttribute('d',level === 1 ? 'M4 7.5l3.2 3.2L16 2' : 'M1.5 7.5l3.2 3.2L13.5 2 M8.8 9l1.7 1.7L19 2')
  svg.append(path)
  badge.append(svg)
  time.append(badge)
}

function renderChat(account) {
  renderChatDirectory()
  byId('thread').hidden = !model.chat || !account
  updateChatTheme()
  if (byId('thread').hidden) return
  const online = !deviceMode && account.status === 'Conectado'
  byId('send').hidden = !online && !localChatEnabled
  const offline = byId('offline-history')
  offline.hidden = online
  offline.textContent = deviceMode ? 'Sem conexão · envios ficam pendentes neste aparelho.' : online ? '' : account.storedHistory ? 'Histórico salvo neste computador · ' + account.status :
    'Aguardando a conexão para abrir as mensagens. Para consultar o histórico salvo agora, reinicie o WhatsIA no terminal.'
  const chat = model.chats.find(item => item.id === model.chat && item.accountId === account.id)
  const heading = byId('thread-header')
  const chatId = model.chat
  const direct = !chatId.endsWith('@g.us')
  const namedMessage = direct && model.messages.findLast(m => !m.fromMe && m.personId && m.senderName &&
    !['Contato sem nome','WhatsApp'].includes(m.senderName))
  const title = direct && (!chat?.name || /@(lid|c\.us|s\.whatsapp\.net)$/.test(chat.name) || chat.name === 'Contato sem nome')
    ? namedMessage?.senderName || 'Contato sem nome' : chat?.name || chatId
  const headerStamp = JSON.stringify([account.id, chatId, title, chat?.group, account.feedback, online])
  if (headerStamp !== chatHeadingStamp) {
    chatHeadingStamp = headerStamp
    const identity = element('div')
    identity.className = 'chat-identity'
    const name = element('div')
    name.append(element('strong', title), element('small',account.name))
    identity.append(chatAvatar(account.id, chat || { id: chatId, name: chatId }), name)
    heading.replaceChildren(mobileChatBack,identity)
    const tools = element('details')
    tools.className = 'chat-tools'
    const menu = element('summary', 'Opções da conversa')
    menu.setAttribute('aria-label','Opções da conversa')
    tools.append(menu)
    const actions = element('div')
    tools.append(element('small', 'Conta · ' + account.name), actions)
    heading.append(tools)
    if (online) actions.append(button('Ações do WhatsApp', () => openWhatsAppActions({account:account.id,chat:chatId,operation:chat?.group ? 'group.participants' : 'chat.text'})))
    actions.append(button('Mensagens apagadas', () => openArchive(account.id, chatId)))
    actions.append(button('Configurar arquivo', () => editArchiveSettings(account.id, chatId)))
    if (online) actions.append(button('Contexto da I.A.', () => editContext(account.id, chatId, chat?.name || chatId)))
    if (chat?.group) {
      const enabled = account.feedback.includes(chat.id)
      actions.append(button(enabled ? 'Remover dos resumos' : 'Incluir nos resumos', async () => {
        const feedback = enabled ? account.feedback.filter(id => id !== chat.id) : [...account.feedback, chat.id]
        await api(accountUrl(account.id), 'PATCH', { feedback, chat: chat.id, chatName: chat.name })
        await refresh()
      }))
    }
  }
  const now = new Date()
  const today = chatCalendarDate.format(now)
  // A receipt can arrive while a voice note is playing. Update just its clock.
  const pending = pendingChatRows.filter(row => row.account === account.id && row.chat === chatId)
  const stamp = JSON.stringify([today, account.id, model.chat, model.messages, pending, model.source, online, [...selectedMessages]],
    (key,value)=>key === 'ack' ? undefined : value)
  if (stamp === chatStamp) {
    for (const message of model.messages) {
      const entry = outgoingClocks.get(message.id)
      if (entry && entry.ack !== message.ack) {
        renderReceipt(entry.time,message.ack)
        entry.ack = message.ack
      }
    }
    return
  }
  outgoingClocks.clear()
  chatStamp = stamp
  closeMessageActions()
  renderSelection()
  const list = byId('messages')
  const previousScroll = list.scrollTop
  const nearBottom = list.scrollHeight - list.clientHeight - previousScroll < 48
  const listTop = list.getBoundingClientRect().top
  const anchor = [...list.children].find(row => row.dataset.messageId && row.getBoundingClientRect().bottom > listTop)
  const anchorOffset = anchor && anchor.getBoundingClientRect().top - listTop
  const quoteById = new Map()
  for (const row of model.messages) {
    quoteById.set(row.id, row)
    const stanza = row.id.split('_')[2]
    if (stanza) quoteById.set(stanza, row)
  }
  function messageBubble(message) {
    const node = element('div')
    node.dataset.messageId = message.id
    node.className = 'message' + (message.fromMe ? ' mine' : '') + (model.source === message.id ? ' highlight' : '')
    if (!direct && !message.fromMe) {
      const sender = element('small', message.senderName || 'Participante sem nome')
      sender.className = 'message-sender'
      node.append(sender)
    }
    if (message.revoked) {
      node.classList.add('message-revoked')
      node.append(element('strong', 'Mensagem apagada'))
      if (message.revoked === 'unavailable') {
        node.append(element('p', 'O Agente ainda não tem uma cópia desta mensagem.'))
        return node
      }
      node.append(archiveReveal(account.id, chatId, message.id))
      return node
    }
    const original = quoteById.get(message.quotedId) || quoteById.get(message.quotedStanza)
    if (original) {
      const quote = element('blockquote')
      quote.className = 'chat-quote'
      const author = original.fromMe ? 'Você' : original.senderName || (direct ? title : 'Participante')
      quote.append(element('strong',author),element('span',original.revoked ? 'Mensagem apagada' :
        original.body || original.transcript || chatPreview({type:original.type}) || 'Mensagem'))
      node.append(quote)
    }
    if (message.type === 'ptt' || message.type === 'audio') {
      const audioLabel = element('small',message.isForwarded ? 'Áudio encaminhado' :
        message.type === 'ptt' ? 'Mensagem de voz' : 'Arquivo de áudio')
      audioLabel.className = 'audio-origin'
      if (message.isForwarded) audioLabel.classList.add('forwarded')
      node.append(audioLabel)
    }
    if (message.vCards?.length) {
      for (const vcard of message.vCards) {
        const contact = element('details')
        contact.append(element('summary', /^FN:(.+)$/mi.exec(vcard)?.[1]?.trim() || 'Cartão de contato'), element('pre', vcard))
        node.append(contact)
      }
    }
    if (message.body && !message.vCards?.length && !message.location) {
      const formatted = element('div')
      formatted.className = 'wa-text'
      formatted.append(formatWhatsApp(document, message.body))
      node.append(formatted)
    }
    if (message.location) {
      const {latitude, longitude, description} = message.location
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) node.append(element('p', [description, [latitude, longitude].join(', ')].filter(Boolean).join(' · ')))
    }
    if (message.poll) node.append(element('strong', message.poll.title), element('p', message.poll.options.join(' · ')))
    if (message.reactions?.length || message.hasReaction) {
      const reactions = button(message.reactions?.map(r => r.emoji + ' ' + r.count).join('   ') || 'Ver reações',
        () => openWhatsAppActions({account:account.id,chat:chatId,message:message.id,operation:'message.getReactions',inspect:true}))
      reactions.disabled = !online
      reactions.className = 'wa-reactions'
      node.append(reactions)
    }
    if (message.transcript) {
      node.append(mediaNote(message.id, 'Transcrição do áudio', message.transcript))
    } else if (message.transcriptionError) node.append(element('small', message.transcriptionError))
    if (message.mediaRemoved) node.append(element('small','Mídia removida para liberar espaço'))
    const media = message.mediaContext
    if (media?.kind === 'image') {
      if (media.text) node.append(mediaNote(message.id, 'Descrição da imagem', media.text))
      if (media.partial && media.note) node.append(element('small', media.note))
    }
    if ((online || deviceMode) && message.media) {
      if (message.type === 'image' || message.type === 'sticker') {
        const photo = element('img')
        photo.className = 'chat-message-photo'
        photo.loading = 'lazy'
        photo.alt = 'Foto compartilhada na conversa'
        photo.tabIndex = 0
        photo.setAttribute('role','button')
        photo.setAttribute('aria-label','Abrir imagem')
        photo.onclick = () => openChatMedia(account.id,chatId,message,title)
        photo.onkeydown = event => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          photo.click()
        }
        photo.src = accountUrl(account.id) + '/media/' + pathPart(message.id) + '?preview=1'
        photo.onerror = () => photo.replaceWith(element('small','Imagem indisponível neste aparelho'))
        node.append(photo)
      }
      if (['audio','ptt','video'].includes(message.type)) {
        const player = element(message.type === 'video' ? 'video' : 'audio')
        player.controls = true
        player.preload = 'none'
        player.src = accountUrl(account.id) + '/media/' + pathPart(message.id) + '?preview=1'
        node.append(player)
      }
    }
    if (message.media && !message.body && ((!online && !deviceMode) || !['image', 'sticker', 'audio', 'ptt', 'video'].includes(message.type))) {
      node.append(element('p', chatPreview({ type: message.type }) || 'Anexo'))
    }
    if (media && media.kind !== 'image') {
      const details = element('details')
      details.append(element('summary', 'Trecho do PDF'), element('p', media.text || 'Nenhum trecho disponível.'))
      if (media.partial) details.append(element('small', media.note || 'Leitura parcial do PDF.'))
      node.append(details)
    } else if (!media && message.mediaContextError) node.append(element('small', message.mediaContextError))
    if (selectedMessages.size) {
      const checkbox = element('input')
      checkbox.type = 'checkbox'
      checkbox.checked = selectedMessages.has(message.id)
      checkbox.setAttribute('aria-label', 'Selecionar mensagem')
      checkbox.onchange = act(() => toggleMessage(message.id))
      node.classList.toggle('message-selected', checkbox.checked)
      node.prepend(checkbox)
    } else if (online || message.body || message.transcript) {
      node.append(messageMenu(account.id, chatId, message, online))
    }
    return node
  }

  const previousDate = new Date(now)
  previousDate.setDate(previousDate.getDate() - 1)
  const yesterday = chatCalendarDate.format(previousDate)
  const rows = document.createDocumentFragment()
  let lastDay
  for (const message of model.messages) {
    const bubble = messageBubble(message)
    const sent = new Date(message.timestamp)
    if (message.timestamp != null && Number.isFinite(sent.getTime())) {
      const day = chatCalendarDate.format(sent)
      if (day !== lastDay) {
        const separator = element('div', day === today ? 'Hoje' : day === yesterday ? 'Ontem' : day)
        separator.className = 'chat-day'
        rows.append(separator)
        lastDay = day
      }
      const time = element('time', chatClock.format(sent))
      time.className = 'message-time'
      time.dateTime = sent.toISOString()
      if (message.fromMe && !message.revoked) {
        renderReceipt(time,message.ack)
        outgoingClocks.set(message.id,{time,ack:message.ack})
      }
      bubble.insertBefore(time, bubble.querySelector('.message-action-trigger'))
    }
    const previous = rows.lastElementChild
    if (previous?.classList.contains('message') && previous.dataset.author === (message.fromMe ? 'self' : (message.sender || 'peer'))) {
      previous.classList.remove('group-end')
    }
    bubble.dataset.author = message.fromMe ? 'self' : (message.sender || 'peer')
    bubble.classList.add('group-end')
    rows.append(bubble)
  }
  for (const row of pending) {
    const bubble = element('div')
    bubble.className = 'message mine'
    if (row.attachment) bubble.append(element('small',row.attachment))
    if (row.body) bubble.append(element('div',row.body))
    const status = element('small',row.reason || '◷ Pendente')
    status.className = 'message-time'
    bubble.append(status)
    if (row.reason) bubble.append(button('Dispensar aviso',async () => {
      await offlineChat.finish(row)
      await updatePending()
    }))
    rows.append(bubble)
  }
  list.replaceChildren(rows)
  const source = historyWindow.focusSource && model.source && list.querySelector('.highlight')
  if (source) {
    source.scrollIntoView({ block: 'nearest' })
    historyWindow.focusSource = false
  } else if (nearBottom && !historyWindow.older && !selectedMessages.size) list.scrollTop = list.scrollHeight
  else {
    const replacement = anchor && [...list.children].find(row => row.dataset.messageId === anchor.dataset.messageId)
    list.scrollTop = replacement ? list.scrollTop + replacement.getBoundingClientRect().top - listTop - anchorOffset : previousScroll
  }
}

function sourceButton(account, chat, id) {
  return button('Abrir mensagem', () => openChat(account, chat, id))
}

let skillRunStamp = ''
function renderSkillRuns(runs) {
  const stamp = JSON.stringify(runs)
  if (stamp === skillRunStamp) return
  skillRunStamp = stamp
  const labels = { queued: 'Na fila', review: 'Aguardando revisão', sending: 'Enviando',
    done: 'Concluída', dismissed: 'Dispensada', canceled: 'Cancelada', uncertain: 'Envio sem confirmação' }
  const cards = runs.map(run => {
    const card = element('article')
    card.append(element('strong', run.skillName),
      element('small', [labels[run.status], run.destination?.accountName || run.accountName, run.destination?.name || run.recipient].filter(Boolean).join(' · ')))
    if (run.body) card.append(element('p', run.body))
    if (run.reason) card.append(element('p', run.reason))
    if (run.status === 'uncertain') card.append(element('p', 'Confira o destino para saber se recebeu a ação.'))
    card.append(sourceButton(run.account, run.chat, run.source))
    const update = action => async () => {
      await api('/api/ai/skill-runs/' + pathPart(run.id), 'PATCH', { action })
      await refresh()
    }
    if (run.status === 'review') {
      if (run.action === 'draft' && run.body) card.append(button('Confirmar envio', act(update('send'))))
      card.append(button('Dispensar', act(update('dismiss'))))
    }
    return card
  })
  const activity = byId('skill-activity')
  activity.querySelector('summary').textContent = 'Execuções de skills' + (runs.some(run => run.status === 'review') ? ' · Revisão pendente' : '')
  byId('skill-runs').replaceChildren(...(cards.length ? cards : [element('p', 'Nenhuma execução registrada.')]))
}

let historyJobsStamp = ''
function renderHistoryJobs(jobs) {
  const stamp = JSON.stringify(jobs)
  if (stamp === historyJobsStamp) return
  historyJobsStamp = stamp
  const area = byId('history-jobs')
  area.hidden = jobs.length === 0
  const visible = jobs.filter(historyBusy)
  if (jobs[0] && !visible.includes(jobs[0])) visible.push(jobs[0])
  area.replaceChildren(...visible.map(job => {
    const row = element('p', job.title + ' · ' + historyJobLabel(job))
    if (historyBusy(job) && job.status !== 'stopping') {
      row.append(' ', button('Parar', act(async () => {
        await api(chatUrl(job.account, job.chat) + '/context/history', 'PATCH', { action: 'stop', id: job.id })
        await refresh()
      })))
    }
    return row
  }))
}

let aiActionSkills = []
function renderAI(result) {
  aiActionSkills = (result.skills || []).filter(skill => skill.wa)
  conversationProvider = result.chatProvider
  renderSkillRuns(result.skillRuns || [])
  renderSkillProposals(result.skillProposals || [])
  renderHistoryJobs(result.historyJobs || [])
  aiChats = result.chats || []
  renderAiChats()
  if (!byId('ask-response').childNodes.length) renderAiThread()
  byId('ai-thread-title').textContent = aiChats.find(chat => chat.id === selectedAiChat)?.title || 'Nova conversa'
  const skills = result.skills || []
  const stamp = JSON.stringify(skills)
  const picker = askForm.elements.skill
  if (stamp !== skillOptionsStamp) {
    skillOptionsStamp = stamp
    const selected = picker.value
    picker.replaceChildren(new Option('Seleção automática', ''), new Option('Sem skill', 'off'),
      ...skills.map(skill => new Option(skill.name, skill.id)))
    if ([...picker.options].some(option => option.value === selected)) picker.value = selected
  }
  const chosen = askForm.elements.account.value || model.accounts.find(item => item.mode === 'local')?.id || model.accounts.find(item => item.mode === 'cloud')?.id || model.account
  askForm.elements.account.replaceChildren(...model.accounts.map(account => new Option(account.name, account.id)))
  if (model.accounts.some(account => account.id === chosen)) askForm.elements.account.value = chosen
  updateAskScope()
  const accountName = id => model.accounts.find(account => account.id === id)?.name || id
  byId('actions').replaceChildren(...result.actions.map(item => {
    const card = element('article')
    card.append(element('strong', item.title), element('p', [accountName(item.account), item.sender, item.due, { open: 'Aberta', done: 'Concluída', dismissed: 'Descartada', snoozed: 'Adiada' }[item.status]].filter(Boolean).join(' · ')),
      sourceButton(item.account, item.chat, item.latest || item.source))
    const filesUrl = '/api/actions/' + pathPart(item.id) + '/files'
    const upload = async file => {
      if (!file || file.size < 1 || file.size > 5 * 1024 * 1024) throw new Error('Selecione um arquivo de até 5 MiB.')
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result.split(',')[1])
        reader.onerror = () => reject(new Error('Falha ao ler o arquivo.'))
        reader.readAsDataURL(file)
      })
      await api(filesUrl, 'POST', { name: file.name, data })
      await refresh()
    }
    const picker = element('input')
    picker.type = 'file'
    picker.setAttribute('aria-label', 'Vincular arquivo à pendência')
    picker.onchange = act(() => upload(picker.files[0]))
    card.ondragover = event => {
      if (event.dataTransfer.types.includes('Files')) event.preventDefault()
    }
    card.ondrop = event => {
      if (!event.dataTransfer.files.length) return
      event.preventDefault()
      const file = event.dataTransfer.files[0]
      upload(file).catch(failure => error(failure.message))
    }
    card.append(picker)
    for (const file of item.files || []) {
      const link = element('a', file.name)
      link.href = filesUrl + '/' + pathPart(file.id)
      link.download = file.name
      const row = element('div')
      row.append(link)
      card.append(row)
    }
    if (item.reason) card.append(element('small', item.reason))
    if (item.possiblyResolved) card.append(element('p', 'Possivelmente resolvida'), sourceButton(item.account, item.chat, item.possiblyResolved))
    for (const [status, label] of [['open', 'Reabrir'], ['done', 'Concluir'], ['dismissed', 'Descartar'], ['snoozed', 'Adiar']]) {
      if (status !== item.status) card.append(button(label, async () => {
        await api('/api/actions/' + item.id, 'PATCH', { status })
        await refresh()
      }))
    }
    return card
  }))
  if (!result.actions.length) byId('actions').append(element('p', 'Nenhuma pendência registrada.'))
  byId('summaries').replaceChildren(...result.summaries.map(item => {
    const card = element('article')
    card.append(element('strong', [item.date, accountName(item.account), item.chatName || item.chat, item.partial ? 'Parcial' : ''].filter(Boolean).join(' · ')))
    for (const [key, title] of Object.entries({ issues: 'Problemas', suggestions: 'Sugestões e elogios', recurring: 'Recorrências', actions: 'Ações', resolved: 'Resolvidos' })) {
      if (!item.sections[key]?.length) continue
      card.append(element('h3', title))
      for (const entry of item.sections[key]) card.append(element('p', entry.text), ...entry.sourceIds.map(id => sourceButton(item.account, item.chat, id)))
    }
    return card
  }))
  if (result.summaryError || !result.summaries.length) byId('summaries').append(element('p', result.summaryError || 'Nenhum resumo disponível.'))
  byId('ai-status').replaceChildren(...result.providerIssues.map(issue => {
    const card = element('article')
    card.append(element('strong', accountName(issue.account)), element('p', issue.message),
      element('small', 'A fila está pausada. O aplicativo tentará novamente em até 1 minuto.'))
    return card
  }))
  byId('partial').replaceChildren(...result.partial.map(item => {
    const card = element('article')
    card.append(element('p', item.note), sourceButton(item.account, item.chat, item.id))
    return card
  }))
}

let analysisQueue = null
let changingAnalysis = false
const analysisToggle = byId('analysis-toggle')
const analysisRetry = byId('analysis-retry')

function renderAnalysisQueue(queue) {
  analysisQueue = queue
  const waiting = Math.max(0, queue.pending - Number(Boolean(queue.active)))
  const status = [queue.enabled ? 'Ativa' : 'Pausada', waiting + ' na fila local']
  if (queue.interceptionsActive === false) status.push('Interceptação desativada')
  if (queue.sendingActive === false) status.push('Envios de WhatsApp desativados')
  if (queue.active) status.push('Analisando · ' + queue.active.account)
  if (queue.blocked) status.push(queue.blocked + ' aguardando conta, modo de I.A. ou mídia')
  if (queue.errors) status.push(queue.errors + ' com falha')
  if (queue.exactPending) status.push(queue.exactPending + ' mensagens para skills de frase exata')
  if (queue.skillQueued) status.push(queue.skillQueued + ' ações na fila')
  if (queue.skillReview) status.push(queue.skillReview + ' ações para revisar em Skills')
  const label = status.join(' · ')
  if (byId('analysis-queue-status').textContent !== label) byId('analysis-queue-status').textContent = label
  analysisToggle.textContent = queue.enabled ? 'Pausar análise' : 'Retomar análise'
  analysisToggle.setAttribute('aria-pressed', String(!queue.enabled))
  analysisRetry.hidden = !queue.errors
  analysisToggle.disabled = changingAnalysis
  analysisRetry.disabled = changingAnalysis
}

async function changeAnalysis(payload) {
  if (changingAnalysis || !analysisQueue) return
  changingAnalysis = true
  renderAnalysisQueue(analysisQueue)
  try {
    renderAnalysisQueue(await api('/api/message-analysis', 'PATCH', payload))
  } finally {
    changingAnalysis = false
    renderAnalysisQueue(analysisQueue)
  }
}
analysisToggle.onclick = act(() => changeAnalysis({ enabled: !analysisQueue.enabled }))
analysisRetry.onclick = act(() => changeAnalysis({ retry: true }))

let todayStamp = ''
let attachmentStamp = ''
let attachmentIssues = []
let attachmentPage = 0
let attachmentMatches = 0
const attachmentPageSize = 8
const attachmentPanel = byId('attachment-panel')
const attachmentTitle = { audio: 'Áudio', image: 'Imagem', document: 'Documento' }
const attachmentCategory = item => ['audio', 'image'].includes(item.type) ? item.type : 'document'
const todayDate = value => new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long'
}).format(new Date(value + 'T12:00:00Z'))

function attachmentCard(item) {
  const row = element('article')
  row.className = 'attachment-row'
  const main = element('div')
  main.append(element('strong', attachmentTitle[attachmentCategory(item)]),
    element('small', [item.accountName, item.timestamp && new Date(item.timestamp).toLocaleDateString('pt-BR')].filter(Boolean).join(' · ')),
    element('p', item.reason))
  const retry = button('Tentar novamente', async () => {
    retry.disabled = true
    try {
      const result = await api(accountUrl(item.account) + '/attachments/' + pathPart(item.id) + '/retry', 'POST', {})
      if (!result.recovered && result.reason) error(result.reason)
      await refresh()
    } finally { retry.disabled = false }
  })
  const controls = element('div')
  controls.className = 'today-card-actions'
  controls.append(sourceButton(item.account, item.chat, item.id), retry)
  row.append(main, controls)
  return selectableTodayCard(row, item)
}

function renderAttachmentIssues() {
  if (!attachmentPanel.open) return
  const pages = Math.ceil(attachmentMatches / attachmentPageSize)
  const start = attachmentPage * attachmentPageSize
  const cards = attachmentIssues.map(attachmentCard)
  byId('attachment-issues').replaceChildren(...(cards.length ? cards : [element('p','Nenhuma falha para esses filtros.')]))
  byId('attachment-page').textContent = attachmentMatches ? (start + 1) + '–' + (start + cards.length) + ' de ' + attachmentMatches : '0 resultados'
  byId('attachment-prev').disabled = attachmentPage === 0
  byId('attachment-next').disabled = attachmentPage >= pages - 1
}

function filterKey(value) {
  return String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

attachmentPanel.addEventListener('toggle', renderAttachmentIssues)
for (const id of ['attachment-type', 'attachment-search']) byId(id).addEventListener('input', () => {
  attachmentPage = 0
  updateTodayList('attachments',byId('attachment-search').value,8,150)
})
byId('attachment-prev').onclick = () => { attachmentPage--; refreshTodayCards().catch(failure => error(failure.message)) }
byId('attachment-next').onclick = () => { attachmentPage++; refreshTodayCards().catch(failure => error(failure.message)) }

let todayCategories = []
let editedCategory = null
let draggedCategory = null
let historyCategory = null
let categoryOffset = 0
let historyRequest = 0

const markedToday = new Map()
let todaySelectionAvailable = false
let markingToday = false
let pendingBatch
let savingBatch = false
let todayRevision = 0
const todayListOptions = new Map()
let todayFilterTimer
let historyFilterTimer
function updateTodayList(id, query, limit, delay = 0) {
  if (query || limit > 12) todayListOptions.set(id,[query,limit])
  else todayListOptions.delete(id)
  todayRevision++
  clearTimeout(todayFilterTimer)
  todayFilterTimer = setTimeout(() => refreshTodayCards().catch(failure => error(failure.message)), delay)
}
let todayScope = localStorage.getItem('whatsia.todayAccount') || 'all'
let loadedTodayScope = null
const todayAccount = byId('today-account')
function todayUrl(path, scope = todayScope) {
  return path + (path.includes('?') ? '&' : '?') + 'account=' + pathPart(scope)
}
function changeTodayScope(scope) {
  todayScope = scope
  todayAccount.value = scope
  localStorage.setItem('whatsia.todayAccount', scope)
  window.dispatchEvent(new Event('whatsia-notice-scope'))
  loadedTodayScope = null
  todayRevision++
  todayListOptions.clear()
  clearTimeout(todayFilterTimer)
  clearTimeout(historyFilterTimer)
  attachmentPanel.hidden = true
  byId('attachment-type').value = ''
  byId('attachment-search').value = ''
  historyRequest++
  markedToday.clear()
  pendingBatch = null
  markingToday = false
  todaySelectionAvailable = false
  updateTodaySelection()
  for (const id of ['today-batch-dialog','category-history']) if (byId(id).open) byId(id).close()
  todayStamp = attachmentStamp = ''
  attachmentPage = 0
  attachmentIssues = []
  byId('today-command').reset()
  byId('today-result').textContent = ''
  byId('today-tab-label').textContent = 'Hoje'
  for (const id of ['today-overview','hidden-category-list','attachment-issues','category-history-items']) byId(id).replaceChildren()
  byId('attachment-count').textContent = '0'
  byId('hidden-categories').hidden = true
  byId('today-list').textContent = 'Carregando…'
}
function renderTodayAccounts() {
  const options = [['all','Todas as contas'],...model.accounts.map(a=>[a.id,a.name])]
  const stamp = JSON.stringify(options)
  if (todayAccount.dataset.stamp !== stamp) {
    todayAccount.replaceChildren(...options.map(([value,name])=>new Option(name,value)))
    todayAccount.dataset.stamp = stamp
  }
  if (!options.some(([id])=>id===todayScope)) changeTodayScope('all')
  todayAccount.value = todayScope
}
todayAccount.onchange = act(async () => {
  changeTodayScope(todayAccount.value)
  await refreshTodayCards()
})
const batchDialogToday = byId('today-batch-dialog')
const batchFormToday = byId('today-batch-form')

const openSupplements = new Set()
function selectableTodayCard(row, item) {
  if (item.update) {
    const {summary,timestamp,history,count} = item.update
    const updated = element('div')
    updated.append(element('small','Atualizado em ' + new Date(timestamp).toLocaleString('pt-BR')),element('p',summary))
    const details = element('details')
    const key = item.card?.key
    details.open = openSupplements.has(key)
    details.ontoggle = () => {
      if (!key || !details.isConnected) return
      if (details.open) openSupplements.add(key)
      else openSupplements.delete(key)
    }
    details.append(element('summary',count===1 ? 'Ver complemento' : 'Ver complementos ('+count+')'))
    if (item.preview) details.append(element('p','Mensagem inicial · ' + item.preview))
    for (const change of history) {
      const line = element('p',change.quote)
      line.append(button('Abrir mensagem',()=>{
        if (byId('category-history').open) byId('category-history').close()
        return openChat(change.account,change.chat,change.source)
      }))
      details.append(line)
    }
    updated.append(details)
    row.querySelector('strong')?.after(updated)
  }
  if (!item.card) return row
  const identity = JSON.stringify([item.card.key, item.card.category])
  const check = element('input')
  check.type = 'checkbox'
  check.className = 'today-card-check'
  check.dataset.identity = identity
  check.checked = markedToday.has(identity)
  check.setAttribute('aria-label', 'Marcar ' + (item.title || item.topic || row.querySelector('strong')?.textContent || 'cartão'))
  check.onchange = () => {
    if (check.checked) markedToday.set(identity, item.card)
    else markedToday.delete(identity)
    updateTodaySelection()
  }
  row.prepend(check)
  row.addEventListener('click', event => {
    if (markingToday && !event.target.closest('button, a, input, select, textarea, summary, label')) check.click()
  })
  return row
}

const selectionBars = ['today-card-tools', 'history-card-tools'].map(id => {
  const bar = byId(id)
  bar.className = 'today-card-tools'
  const toggle = button('Selecionar cartões', () => {
    if (!todaySelectionAvailable) throw new Error('Reinicie o WhatsIA no terminal para ativar a seleção de cartões.')
    markingToday = !markingToday
    markedToday.clear()
    updateTodaySelection()
  })
  const scope = id === 'today-card-tools' ? byId('today-view') : byId('category-history')
  const all = button('Marcar visíveis', () => {
    for (const check of scope.querySelectorAll('.today-card-check')) {
      if (check.getClientRects().length && !check.checked) {
        const [key, category] = JSON.parse(check.dataset.identity)
        markedToday.set(check.dataset.identity, { key, category })
      }
    }
    updateTodaySelection()
  })
  const count = element('span')
  count.setAttribute('role', 'status')
  const move = button('Mover', () => openTodayBatch('move'))
  const remove = button('Apagar', () => openTodayBatch('delete'))
  bar.append(toggle, count, all, move, remove)
  return { toggle, count, all, move, remove }
})
function updateTodaySelection() {
  document.body.classList.toggle('marking-today', markingToday)
  for (const check of document.querySelectorAll('.today-card-check')) check.checked = markedToday.has(check.dataset.identity)
  for (const { toggle, count, all, move, remove } of selectionBars) {
    toggle.textContent = markingToday ? 'Cancelar seleção' : 'Selecionar cartões'
    toggle.setAttribute('aria-pressed', String(markingToday))
    for (const control of [count, all, move, remove]) control.hidden = !markingToday
    move.disabled = remove.disabled = !markedToday.size
    count.textContent = markedToday.size + (markedToday.size === 1 ? ' marcado' : ' marcados')
  }
}
updateTodaySelection()

function openTodayBatch(action) {
  const items = [...markedToday.values()]
  if (!items.length) return
  const move = action === 'move'
  const destination = batchFormToday.elements.destination
  destination.replaceChildren(new Option('Escolha a categoria', ''), ...todayCategories
    .filter(category => items.some(item => item.category !== category.id))
    .map(category => new Option(category.name + (category.hidden ? ' (oculta)' : ''), category.id)))
  if (items.every(item => item.key.startsWith('["attachment",')) && items.some(item => item.category !== 'attachments')) {
    destination.add(new Option('Anexos com falha', 'attachments'))
  }
  destination.required = move
  destination.disabled = !move
  byId('today-batch-target').hidden = !move
  const amount = items.length + (items.length === 1 ? ' cartão' : ' cartões')
  byId('today-batch-title').textContent = (move ? 'Mover ' : 'Apagar ') + amount
  byId('today-batch-detail').textContent = move ? 'Os cartões passarão para a categoria escolhida.' :
    'Os cartões serão removidos das listas selecionadas de Hoje. As mensagens e os registros de origem serão preservados.'
  byId('today-batch-submit').textContent = move ? 'Mover' : 'Apagar do Hoje'
  byId('today-batch-error').textContent = ''
  pendingBatch = { action, items, scope:todayScope }
  batchDialogToday.showModal()
  if (move) destination.focus()
  else byId('today-batch-cancel').focus()
}
byId('today-batch-cancel').onclick = () => batchDialogToday.close()
batchDialogToday.addEventListener('cancel', event => { if (savingBatch) event.preventDefault() })
batchFormToday.onsubmit = async event => {
  event.preventDefault()
  if (!pendingBatch || savingBatch) return
  savingBatch = true
  const payload = { ...pendingBatch, destination: batchFormToday.elements.destination.value }
  byId('today-batch-submit').disabled = byId('today-batch-cancel').disabled = true
  try {
    const result = await api(todayUrl('/api/today/cards/batch',payload.scope), 'POST', payload)
    if (payload.scope !== todayScope) return
    batchDialogToday.close()
    markedToday.clear()
    markingToday = false
    updateTodaySelection()
    const count = payload.items.length
    const targetName = payload.destination === 'attachments' ? 'Anexos com falha' : todayCategories.find(item => item.id === payload.destination)?.name
    byId('today-result').textContent = count + (count === 1 ? ' cartão' : ' cartões') +
      (payload.action === 'move' ? ' em ' + targetName + '.' :
        (count === 1 ? ' removido de Hoje.' : ' removidos de Hoje.'))
    if (result.learned) byId('today-result').textContent += ' O WhatsIA vai usar essa mudança para classificar mensagens semelhantes desta conta.'
    await refreshTodayCards()
    if (byId('category-history').open) await categoryPage(categoryOffset)
  } catch (failure) {
    if (batchDialogToday.open) byId('today-batch-error').textContent = failure.message
    else error(failure.message)
  } finally {
    savingBatch = false
    byId('today-batch-submit').disabled = byId('today-batch-cancel').disabled = false
  }
}

async function refreshTodayCards() {
  const revision = ++todayRevision
  const scope = todayScope
  const params = new URLSearchParams({view:'lists',attachmentPage,attachmentType:byId('attachment-type').value})
  if (todayListOptions.size) params.set('lists', JSON.stringify([...todayListOptions].map(([id,[query,limit]])=>[id,query,limit])))
  const today = await api(todayUrl('/api/today?' + params,scope))
  if (revision !== todayRevision || model.tab !== 'today') return
  if (today.accountScope !== scope || today.categories.some(item=>!item.list)) throw new Error('Reinicie o WhatsIA no terminal para carregar o filtro de contas.')
  loadedTodayScope = scope
  renderToday(today, today.attachments)
}

for (const dialogId of ['category-manager', 'category-editor', 'category-history']) {
  const dialog = byId(dialogId)
  dialog.querySelector('[data-close]').onclick = () => dialog.close()
}
function dragCategory(handle, target, id) {
  handle.draggable = true
  handle.ondragstart = event => {
    draggedCategory = id
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
  }
  handle.ondragend = () => { draggedCategory = null }
  target.ondragover = event => {
    if (draggedCategory && draggedCategory !== id) event.preventDefault()
  }
  target.ondrop = event => {
    if (!draggedCategory || draggedCategory === id) return
    event.preventDefault()
    const from = todayCategories.findIndex(item => item.id === draggedCategory)
    const to = todayCategories.findIndex(item => item.id === id)
    moveTodayCategory(draggedCategory, id, from < to).catch(reportCategoryError)
    draggedCategory = null
  }
}

function reportCategoryError(failure) {
  if (byId('category-manager').open) byId('category-order-status').textContent = failure.message
  else error(failure.message)
}

async function moveTodayCategory(id, target, after) {
  const data = await api('/api/today/categories/' + pathPart(id) + '/move', 'POST', { target, after })
  todayCategories = data.categories
  renderCategoryOrder()
  await refresh()
}

function renderCategoryOrder() {
  byId('category-order').replaceChildren(...todayCategories.map((item, index) => {
    const row = element('div')
    row.className = 'category-order-row'
    const name = button(item.name, () => editTodayCategory(item))
    name.title = 'Editar ' + item.name
    const up = button('↑', () => moveTodayCategory(item.id, todayCategories[index - 1].id, false).catch(reportCategoryError))
    const down = button('↓', () => moveTodayCategory(item.id, todayCategories[index + 1].id, true).catch(reportCategoryError))
    up.disabled = index === 0
    down.disabled = index === todayCategories.length - 1
    up.setAttribute('aria-label', 'Mover ' + item.name + ' para cima')
    down.setAttribute('aria-label', 'Mover ' + item.name + ' para baixo')
    row.append(name, element('small', item.hidden ? 'Oculta' : ''), up, down)
    dragCategory(row, row, item.id)
    return row
  }))
}

byId('manage-categories').onclick = act(async () => {
  todayCategories = (await api(todayUrl('/api/today'))).categories
  byId('category-order-status').textContent = ''
  renderCategoryOrder()
  byId('category-manager').showModal()
})

function editTodayCategory(item) {
  editedCategory = item
  const fields = byId('category-form').elements
  fields.categoryName.value = item?.name || ''
  fields.rule.value = item?.prompt || ''
  fields.days.value = String(item?.days || 0)
  fields.concealed.checked = Boolean(item?.hidden)
  fields.showNotifications.checked = item?.showNotifications !== false
  byId('category-title').textContent = item ? 'Editar categoria' : 'Nova categoria'
  byId('category-form-error').textContent = ''
  byId('category-editor').showModal()
  fields.categoryName.focus()
}
byId('create-category').onclick = () => editTodayCategory(null)
byId('category-form').onsubmit = async event => {
  event.preventDefault()
  const fields = event.currentTarget.elements
  const submit = event.currentTarget.querySelector('[type=submit]')
  submit.disabled = true
  const item = editedCategory
  try {
    const data = await api('/api/today/categories' + (item ? '/' + pathPart(item.id) : ''), item ? 'PATCH' : 'POST', {
      name: fields.categoryName.value, prompt: fields.rule.value, hidden: fields.concealed.checked, showNotifications:fields.showNotifications.checked,
      days: Number(fields.days.value), revision: item?.revision
    })
    todayCategories = data.categories
    byId('category-editor').close()
    renderCategoryOrder()
    await refresh()
  } catch (failure) { byId('category-form-error').textContent = failure.message }
  finally { submit.disabled = false }
}

function todayAccountName(account) {
  return todayScope === 'all' ? model.accounts.find(item=>item.id===account)?.name || '' : ''
}
const openClassifications = new Set()
function classifiedMessage(message) {
  const row = element('article')
  row.className = 'today-card'
  const date = new Date(message.timestamp).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
  row.append(element('strong', message.title), element('small', [todayAccountName(message.account),date].filter(Boolean).join(' · ')), ...(message.update ? [] : [element('p', message.preview)]),
    button('Abrir mensagem', () => {
      if (byId('category-history').open) byId('category-history').close()
      return openChat(message.account, message.chat, message.id)
    }))
  if (message.evidence || message.canReview) {
    const details = element('details')
    const sources = {atual:'Mensagem',autor:'Autor',conversa:'Conversa',citada:'Mensagem citada'}
    const key = JSON.stringify([message.account,message.id,message.card?.category])
    details.open = openClassifications.has(key)
    details.ontoggle = () => {
      if (!details.isConnected) return
      if (details.open) openClassifications.add(key)
      else openClassifications.delete(key)
    }
    details.append(element('summary','Classificação da lista'))
    if (message.evidence) details.append(element('p',message.evidence.reason),
      element('small',(sources[message.evidence.source] || 'Mensagem anterior') + ' · “' + message.evidence.quote + '”'))
    if (message.review === 'pending') details.append(element('p','Aguardando classificação…'))
    else if (message.canReview) {
      if (message.review === 'error') details.append(element('p','A classificação falhou. Você pode tentar novamente.'))
      details.append(button('Reavaliar listas',async()=>{
        await api(chatUrl(message.account,message.chat)+'/messages/'+pathPart(message.id)+'/review-lists','POST',{})
        await refreshTodayCards()
        if (byId('category-history').open) await categoryPage(categoryOffset)
      }))
    }
    row.append(details)
  }
  return selectableTodayCard(row, message)
}

async function categoryPage(offset) {
  const request = ++historyRequest
  const params = new URLSearchParams({offset,q:byId('category-history-search').value})
  const data = await api(todayUrl('/api/today/categories/' + pathPart(historyCategory) + '/messages?' + params))
  if (request !== historyRequest) return
  if (offset && !data.messages.length) return categoryPage(0)
  categoryOffset = offset
  byId('category-history-items').replaceChildren(...data.messages.map(classifiedMessage))
  byId('category-page').textContent = data.total ? (offset + 1) + '–' + (offset + data.messages.length) + ' de ' + data.total : 'Nenhuma mensagem'
  byId('category-prev').disabled = !offset
  byId('category-next').disabled = offset + data.messages.length >= data.total
  return true
}
byId('category-history-search').oninput = () => {
  historyRequest++
  clearTimeout(historyFilterTimer)
  historyFilterTimer = setTimeout(() => categoryPage(0).catch(failure => error(failure.message)),150)
}
byId('category-prev').onclick = act(() => categoryPage(Math.max(0, categoryOffset - 30)))
byId('category-next').onclick = act(() => categoryPage(categoryOffset + 30))

function renderToday(today, issues) {
  todaySelectionAvailable = today.cardSelection === true
  const lastPage = Math.max(0,Math.ceil(today.attachmentList.matches / attachmentPageSize)-1)
  if (attachmentPage > lastPage) {
    attachmentPage = lastPage
    refreshTodayCards().catch(failure => error(failure.message))
    return
  }
  const issueStamp = JSON.stringify([issues,today.attachmentList,attachmentPage])
  if (issueStamp !== attachmentStamp) {
    attachmentStamp = issueStamp
    attachmentIssues = issues.filter(item => !item.card || item.card.category === 'attachments').map(item => ({ ...item,
      accountName: model.accounts.find(account => account.id === item.account)?.name || '' }))
    attachmentMatches = today.attachmentList.matches
    attachmentPanel.hidden = !today.attachmentList.total
    byId('attachment-count').textContent = String(today.attachmentList.total)
    renderAttachmentIssues()
  }
  const stamp = JSON.stringify([today, issueStamp, [...todayListOptions]])
  if (stamp === todayStamp) return
  todayStamp = stamp
  const dateLabel = byId('today-date')
  dateLabel.dateTime = today.today
  dateLabel.textContent = todayDate(today.today)
  const focused = document.activeElement
  const focusedList = focused?.dataset.todayFilter
  const caret = focusedList ? [focused.selectionStart,focused.selectionEnd] : null
  const offsets = new Map([...byId('today-view').querySelectorAll('.today-list-body')].map(body=>[body.parentElement.id,body.scrollTop]))
  const section = (name, cards, id, count = cards.length) => {
    const block = element('section')
    if (id) {
      block.id = id
      block.className = 'today-section'
      block.tabIndex = -1
    }
    const heading = element('div')
    heading.className = 'today-section-heading'
    heading.append(element('h3', name))
    if (id) {
      const total = element('span', String(count))
      total.className = 'today-count'
      heading.append(total)
    }
    if (id) {
      const body = element('div')
      body.className = 'today-list-body'
      body.setAttribute('role','region')
      body.setAttribute('aria-label',name)
      body.tabIndex = 0
      body.append(...cards)
      block.append(heading,body)
    } else block.append(heading,...cards)
    return block
  }
  const card = (title, detail) => {
    const row = element('article')
    row.className = 'today-card'
    row.append(element('strong', title))
    if (detail) row.append(element('p', detail))
    return row
  }
  const moved = new Map()
  function placeRow(row, item, origin) {
    if (['today-unanswered','today-approvals','today-decisions'].includes(origin)) {
      const name = todayAccountName(item.account)
      if (name) row.querySelector('strong')?.after(element('small',name))
    }
    selectableTodayCard(row, item)
    const target = item.card?.category || origin
    if (target === origin) return row
    if (!moved.has(target)) moved.set(target, [])
    moved.get(target).push(row)
    return null
  }
  const actionCards = today.actions.map(item => {
    const row = card(item.title, [item.accountName, item.due, item.due && item.due < today.today ? 'Atrasada' : null].filter(Boolean).join(' · '))
    if (item.due && item.due <= today.today) row.classList.add('today-card-urgent')
    if (item.impact?.reason) row.append(element('small', item.impact.reason))
    const status = async (value, until, correction) => {
      await api(todayUrl('/api/actions/' + pathPart(item.id), today.accountScope), 'PATCH', { status: value, until, correction })
      await refresh()
    }
    const date = element('input')
    date.type = 'date'
    date.setAttribute('aria-label', 'Adiar até')
    const actions = element('div')
    actions.className = 'today-card-actions'
    const complete = button('Concluir', () => status('done'))
    complete.classList.add('today-primary')
    actions.append(complete, sourceButton(item.account, item.chat, item.source))
    if (item.possiblyResolved) actions.append(button('Ver possível resolução', () => openChat(item.account, item.chat, item.possiblyResolved)))
    const more = element('details')
    more.className = 'today-more'
    const options = element('div')
    options.className = 'today-card-actions'
    options.append(button('Preparar resposta', () => openAiReply(item.account, item.chat, { id: item.source })),
      date, button('Adiar', () => {
        if (!date.value) throw new Error('Selecione a data para adiar.')
        return status('snoozed', date.value)
      }))
    if (!item.followUp) options.append(button('É de outra pessoa', () => status('dismissed', undefined, 'wrong-owner')))
    more.append(element('summary', 'Mais ações'), options)
    row.append(actions, more)
    return placeRow(row, item, item.followUp ? 'today-followups' : 'today-pending')
  })
  const unanswered = today.unanswered.map(item => {
    const row = card(item.title, item.preview)
    const date = element('input')
    date.type = 'date'
    date.setAttribute('aria-label', 'Data do acompanhamento')
    date.min = today.today
    const actions = element('div')
    actions.className = 'today-card-actions'
    const reply = button('Preparar resposta', () => openAiReply(item.account, item.chat, item))
    reply.classList.add('today-primary')
    actions.append(reply, sourceButton(item.account, item.chat, item.id))
    const more = element('details')
    more.className = 'today-more'
    const options = element('div')
    options.className = 'today-card-actions'
    options.append(date, button('Acompanhar', async () => {
      if (!date.value) throw new Error('Selecione a data para acompanhar.')
      await api(todayUrl('/api/today/follow-ups', today.accountScope), 'POST', { account: item.account, chat: item.chat, id: item.id, due: date.value })
      await refresh()
    }), button('Dispensar', async () => {
      await api(todayUrl('/api/today/dismiss', today.accountScope), 'POST', { account: item.account, chat: item.chat, id: item.id })
      await refresh()
    }))
    more.append(element('summary', 'Mais ações'), options)
    row.append(actions, more)
    return placeRow(row, item, 'today-unanswered')
  }).filter(Boolean)
  const approvals = today.approvals.map(item => {
    const row = card(item.title, item.preview)
    row.append(button('Revisar rascunho', async () => {
      show('ai')
      await selectAiChat({ id: item.thread, account: item.account })
    }))
    return placeRow(row, item, 'today-approvals')
  }).filter(Boolean)
  for (const item of today.skills) {
    const row = card(item.title, item.reason)
    row.append(sourceButton(item.account, item.chat, item.source), button('Revisar na I.A.', async () => { show('ai'); await refresh() }))
    if (placeRow(row, item, 'today-approvals')) approvals.push(row)
  }
  const watches = (today.watches || []).map(item => {
    const status = { respondido: 'Resposta sobre o assunto encontrada', atrasado: 'Prazo encerrou sem resposta identificada',
      'vence-hoje': 'A resposta é esperada até hoje', aguardando: 'Aguardando resposta' }
    const row = card(item.topic, [item.accountName, item.due, status[item.status]].filter(Boolean).join(' · '))
    row.append(button(item.source ? 'Ver resposta' : 'Abrir conversa', () => openChat(item.account, item.chat, item.source)),
      button('Dispensar', async () => {
        await api(todayUrl('/api/today/watches/' + pathPart(item.id), today.accountScope), 'PATCH', { action: 'dismiss' })
        await refresh()
      }))
    return placeRow(row, item, 'today-followups')
  }).filter(Boolean)
  const decisions = (today.decisions || []).map(item => {
    const row = card(item.topic, [item.status, item.detail, item.owner, item.due, item.corrected ? 'Corrigido por você' : null]
      .filter(Boolean).join(' · '))
    if (item.source) row.append(sourceButton(item.account, item.chat, item.source))
    if (item.history?.length) {
      const history = element('details')
      history.append(element('summary', 'Ver mudanças'))
      for (const event of item.history) {
        const previous = element('p', [new Date(event.timestamp).toLocaleDateString('pt-BR'), event.status, event.detail].join(' · '))
        if (event.source) previous.append(sourceButton(event.account, event.chat, event.source))
        history.append(previous)
      }
      row.append(history)
    }
    const editor = element('details')
    editor.append(element('summary', 'Corrigir'))
    const status = element('select')
    status.setAttribute('aria-label', 'Situação')
    for (const value of ['proposto', 'confirmado', 'alterado', 'cancelado', 'concluido']) {
      status.append(new Option(value, value, false, value === item.status))
    }
    const detail = element('textarea')
    detail.setAttribute('aria-label', 'Descrição corrigida')
    detail.value = item.detail
    const owner = element('input')
    owner.setAttribute('aria-label', 'Responsável')
    owner.value = item.owner || ''
    const due = element('input')
    due.type = 'date'
    due.setAttribute('aria-label', 'Prazo')
    due.value = item.due || ''
    editor.append(status, detail, owner, due, button('Salvar correção', async () => {
      await api(todayUrl('/api/today/decisions/' + pathPart(item.id), today.accountScope), 'PATCH',
        { status: status.value, detail: detail.value, owner: owner.value, due: due.value || null })
      await refresh()
    }))
    row.append(editor)
    return placeRow(row, item, 'today-decisions')
  }).filter(Boolean)
  const groups = new Map()
  for (const [index, item] of today.actions.entries()) {
    if (!actionCards[index] || item.followUp) continue
    const key = item.topic ? JSON.stringify([item.account,item.topic]) : 'action:' + item.id
    if (!groups.has(key)) groups.set(key, { topic: item.topic, rows: [] })
    groups.get(key).rows.push(actionCards[index])
  }
  const grouped = [...groups.values()].flatMap(({ topic, rows }) => rows.length > 1 ? [section(topic, rows)] : rows)
  const followUps = [...watches, ...actionCards.filter((row, index) => row && today.actions[index].followUp)]
  const alerts = today.alerts
  const overdue = today.categories.find(item=>item.id==='today-pending')?.list.overdue || 0
  for (const issue of issues) {
    if (!issue.card || issue.card.category === 'attachments') continue
    const row = attachmentCard({ ...issue, accountName: model.accounts.find(account => account.id === issue.account)?.name })
    if (!moved.has(issue.card.category)) moved.set(issue.card.category, [])
    moved.get(issue.card.category).push(row)
  }
  const native = {
    'today-pending': { rows: grouped, hint: overdue ? overdue + ' em atraso' : '' },
    'today-unanswered': { rows: unanswered },
    'today-followups': { rows: followUps, hint: alerts ? alerts + ' com prazo' : '' },
    'today-approvals': { rows: approvals },
    'today-decisions': { rows: decisions }
  }
  todayCategories = today.categories
  if (byId('category-manager').open) renderCategoryOrder()
  const visible = [], hidden = [], metrics = []
  for (const item of todayCategories) {
    const {total:count, matches, shown} = item.list
    if (!count) continue
    const base = native[item.id] || {rows:[]}
    const rows = [...base.rows, ...(moved.get(item.id) || [])]
    const [query,limit] = todayListOptions.get(item.id) || ['',12]
    if (item.messages.length) {
      if (rows.length) rows.push(element('h4', 'Mensagens agrupadas'))
      rows.push(...item.messages.map(classifiedMessage))
    }
    if (!matches) rows.push(element('p','Nenhum item corresponde ao filtro.'))
    if (shown < matches) rows.push(button('Mostrar mais', () => updateTodayList(item.id,query,limit+12)))
    const block = section(item.name, rows, item.id, query ? matches + ' de ' + count : count)
    const heading = block.querySelector('.today-section-heading')
    dragCategory(heading.querySelector('h3'), block, item.id)
    if (count > 1 || query) {
      const search = element('input')
      search.type = 'search'
      search.className = 'today-list-search'
      search.dataset.todayFilter = item.id
      search.placeholder = 'Filtrar…'
      search.setAttribute('aria-label','Filtrar ' + item.name)
      search.maxLength = 160
      search.value = query
      search.oninput = () => {
        block.querySelector('.today-list-body').scrollTop = 0
        updateTodayList(item.id,search.value,12,150)
      }
      heading.insertBefore(search,heading.lastElementChild)
    }
    if (item.total > 3) {
      const history = button('Ver histórico', async () => {
        historyCategory = item.id
        byId('category-history-search').value = query
        if (!await categoryPage(0)) return
        byId('category-history-title').textContent = item.name
        byId('category-history').showModal()
      })
      history.className = 'today-history-link'
      block.append(history)
    }
    if (item.hidden) { hidden.push(block); continue }
    visible.push(block)
    const jump = button(item.name, () => {
      block.focus({ preventScroll: true })
      block.scrollIntoView({ block: 'start' })
    })
    jump.className = 'today-metric'
    jump.replaceChildren(element('span', item.name), element('strong', String(count)))
    if (base.hint) jump.append(element('small', base.hint))
    metrics.push(jump)
  }
  byId('today-overview').replaceChildren(...metrics)
  const empty = !visible.length && !hidden.length && !today.attachmentList.total
  byId('today-card-tools').hidden = empty && !markedToday.size
  if (empty) visible.push(element('p','Nenhum item em Hoje para a seleção atual.'))
  byId('today-list').replaceChildren(...visible)
  byId('hidden-category-list').replaceChildren(...hidden)
  byId('hidden-categories').hidden = !hidden.length
  byId('hidden-count').textContent = '(' + hidden.length + ')'
  for (const body of byId('today-view').querySelectorAll('.today-list-body')) body.scrollTop = offsets.get(body.parentElement.id) || 0
  if (focusedList) {
    const search = document.getElementById(focusedList)?.querySelector('.today-list-search')
    if (search) {
      search.focus({preventScroll:true})
      search.setSelectionRange(...caret)
    }
  }
  byId('today-tab-label').textContent = alerts ? 'Hoje (' + alerts + ')' : 'Hoje'
}

const chatDirectories = new Map()
function renderUnreadBadge() {
  const total = model.accounts.reduce((sum, account) => {
    if (account.status !== 'Conectado' || (model.chatScope !== 'all' && account.id !== model.chatScope)) return sum
    return sum + (chatDirectories.get(account.id)?.unread || 0)
  }, 0)
  const badge = byId('chat-tab-unread')
  badge.hidden = total === 0
  badge.textContent = total > 99 ? '99+' : String(total)
  badge.setAttribute('aria-label', total === 1 ? '1 mensagem não lida' : total + ' mensagens não lidas')
}

function updateDirectoryUnread(directory) {
  directory.unread = directory.chats.reduce((sum, chat) => sum + Math.max(0, Number(chat.unread) || 0), 0)
}

function displayDirectories() {
  renderUnreadBadge()
  if (model.tab !== 'chat') return
  const accounts = model.accounts.filter(item => model.chatScope === 'all' || item.id === model.chatScope)
  const notices = []
  model.chats = accounts.flatMap(account => {
    const directory = chatDirectories.get(account.id)
    if (account.status !== 'Conectado') notices.push(account.name + ' · ' + account.status)
    else if (directory?.failed) notices.push(account.name + ' · falha ao atualizar conversas')
    else if (!directory?.chats) notices.push(account.name + ' · carregando conversas')
    if (directory?.chats) return directory.chats
    return Object.entries(account.chatNames || {}).map(([id, name]) => ({
      id, name, group: id.endsWith('@g.us'), timestamp: 0, accountId: account.id, accountName: account.name
    }))
  }).sort((a, b) => b.timestamp - a.timestamp)
  const notice = byId('chat-list-status')
  notice.textContent = notices.join(' | ')
  notice.hidden = !notices.length
  renderChatDirectory()
}

function refreshDirectories() {
  for (const item of model.accounts) {
    if (model.chatScope !== 'all' && model.chatScope !== item.id) continue
    const mode = historyMode(item)
    let directory = chatDirectories.get(item.id)
    if (directory?.mode !== mode) {
      directory = { mode }
      chatDirectories.set(item.id, directory)
    }
    const totalsOnly = model.tab !== 'chat'
    if (totalsOnly && mode !== 'live') continue
    if (mode === 'names' || directory.pending || (mode === 'stored' && directory.chats)) continue
    if (mode === 'device' && directory.chats) continue
    const reads = new Map()
    directory.readsDuringRefresh = reads
    const resource = totalsOnly ? '/unread' : '/chats' + (mode === 'stored' ? '?stored=1' : '')
    directory.pending = api(accountUrl(item.id) + resource).then(result => {
      if (totalsOnly) {
        if (!reads.size) directory.unread = result.unread
      } else {
        directory.chats = result.map(chat => ({
          ...chat, unread: reads.get(chat.id) ?? chat.unread, accountId: item.id, accountName: item.name
        }))
        updateDirectoryUnread(directory)
      }
      directory.failed = false
    }).catch(() => { directory.failed = true }).finally(() => {
      directory.pending = null
      directory.readsDuringRefresh = null
      displayDirectories()
      if (totalsOnly && model.tab === 'chat' && !directory.chats && !directory.failed) refreshDirectories()
    })
  }
  displayDirectories()
}

async function pollThread(account, chat, source) {
  const history = historyWindow
  if (history.polling || history.mode === 'names' || (['device','stored'].includes(history.mode) && history.initialized)) return
  history.polling = true
  try {
    const messages = await latestMessages(account, chat, source)
    if (history !== historyWindow || model.tab !== 'chat') return
    const entry = model.chats.find(item => item.id === chat && item.accountId === account.id)
    if (history.mode === 'live' && messages.length && entry?.unread && document.visibilityState === 'visible') {
      const { unread } = await api(chatUrl(account.id, chat) + '/read', 'POST', {})
      const directory = chatDirectories.get(account.id)
      const current = directory?.chats?.find(item => item.id === chat)
      if (current) {
        current.unread = unread
        directory.readsDuringRefresh?.set(chat, unread)
        updateDirectoryUnread(directory)
        displayDirectories()
      }
    }
  } catch (failure) {
    if (history === historyWindow && model.tab === 'chat') error(failure.message)
  } finally { history.polling = false }
}

let updatingIndicators = false
async function refreshIndicators() {
  if (updatingIndicators) return
  updatingIndicators = true
  try {
    const scope = todayScope
    const [queue, alerts] = await Promise.all([
      api('/api/message-analysis').catch(() => null), api(todayUrl('/api/today/alerts',scope)).catch(() => null)
    ])
    if (alerts && scope === todayScope) byId('today-tab-label').textContent = alerts.count ? 'Hoje (' + alerts.count + ')' : 'Hoje'
    if (queue && !changingAnalysis) renderAnalysisQueue(queue)
  } finally { updatingIndicators = false }
}

async function refresh() {
  if (updating) return
  updating = true
  try {
    const accounts = await api('/api/accounts')
    model.accounts = accounts
    renderTodayAccounts()
    if (!deviceMode) refreshIndicators().catch(failure => error(failure.message))
    model.account ||= accounts.find(item => item.status === 'Conectado')?.id || accounts[0]?.id
    model.chatScope ||= 'all'
    if (localChatEnabled) { await updatePending(); void drainChatQueue().catch(storageWarning) }
    renderChatScope()
    const account = model.accounts.find(item => item.id === model.account)
    renderAccounts()
    renderSession(account)
    if (model.tab === 'chat' || (mobileChat.matches && !document.hidden)) refreshDirectories()
    if (model.tab === 'today') {
      await refreshTodayCards()
    } else if (model.tab === 'skills') {
      const [skills, activity] = await Promise.all([api('/api/ai/skills'), api('/api/ai')])
      renderSkills(skills)
      renderSkillProposals(activity.skillProposals || [])
      renderSkillRuns(activity.skillRuns || [])
    } else if (model.tab === 'ai') {
      renderAI(await api('/api/ai'))
    } else if (model.tab === 'groups') {
      const groups = await api('/api/groups')
      const stamp = directoryStamp(groups)
      if (stamp !== groupStamp) {
        groupList = groups
        groupStamp = stamp
        renderGroups()
      }
    } else if (model.tab === 'people') {
      const directory = await api('/api/people')
      const stamp = directoryStamp(directory)
      if (stamp !== peopleStamp) {
        people = directory
        peopleStamp = stamp
        renderPeople()
      }
    } else if (model.tab === 'chat') {
      if (model.chat && account) prepareHistory(account)
      renderChat(account)
      if (model.chat && account) pollThread(account, model.chat, model.source)

    }
  } finally {
    updating = false
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && model.tab === 'chat' && model.chat) {
    refresh().catch(failure => error(failure.message))
  }
})

const todayCommand = byId('today-command')
const todayResult = byId('today-result')
todayCommand.oninput = () => { todayResult.textContent = '' }
todayCommand.onsubmit = async event => {
  event.preventDefault()
  const field = todayCommand.elements.prompt
  const prompt = field.value
  const scope = todayScope
  const submit = todayCommand.querySelector('button')
  if (submit.disabled) return
  submit.disabled = true
  todayResult.textContent = ''
  try {
    if (loadedTodayScope !== scope) throw new Error('Aguarde o carregamento da conta selecionada.')
    const result = await api(todayUrl('/api/today/command',scope), 'POST', { prompt })
    if (scope === todayScope && field.value === prompt) {
      todayCommand.reset()
      todayResult.textContent = result.answer
    }
    await refresh()
  } catch (failure) {
    if (scope === todayScope && field.value === prompt) todayResult.textContent = failure.message
  } finally { submit.disabled = false }
}
byId('today-tab').onclick = act(async () => { show('today'); await refresh() })
function returnToDirectory() {
  const active = model.chat
  openChat(model.account,null,null,true).catch(failure=>error(failure.message))
  requestAnimationFrame(()=>{
    byId('chat-view').scrollTop = directoryScroll
    const row=[...byId('chats').querySelectorAll('.chat-row')].find(item=>item.dataset.chat===active && item.dataset.account===model.account)
    const target = row || filterChips.querySelector('[aria-pressed="true"]')
    target?.focus({preventScroll:true})
  })
}
mobileChatBack.onclick = () => {
  if (history.state?.whatsiaChat) history.back()
  else returnToDirectory()
}
window.addEventListener('popstate',event=>{
  if (!mobileChat.matches) return
  const route=event.state?.whatsiaChat
  if (route && model.accounts.some(a=>a.id===route.account)) {
    openChat(route.account,route.chat,route.source,true).catch(failure=>error(failure.message))
  } else if (model.tab==='chat' && model.chat) returnToDirectory()
})
byId('chat-tab').onclick = act(async () => {
  if (mobileChat.matches && model.chat) return openChat(model.account,null)
  show('chat')
  await refresh()
})
byId('ai-tab').onclick = act(async () => { show('ai'); await refresh() })
const accountsDrawer = byId('accounts-drawer')
byId('open-accounts').onclick = () => accountsDrawer.showModal()
byId('close-accounts').onclick = () => accountsDrawer.close()
accountsDrawer.onclick = event => {
  if (event.target !== accountsDrawer) return
  const bounds = accountsDrawer.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) accountsDrawer.close()
}
byId('new-account').onsubmit = act(async event => {
  const form = event.currentTarget
  const account = await api('/api/accounts', 'POST', { name: form.elements.name.value })
  form.reset()
  accountsDrawer.close()
  await openChat(account.id, null)
})
const selectedMentions = new Set()
const composer = byId('send')
const filesInput = byId('chat-files')
const preview = byId('chat-preview')
const recordingButton = byId('voice-record')
const selectedMessages = new Set()
let pendingAttachments = []
let recording
let composerRevision = 0
let sendingChat = false
const fileLimit = 10 * 1024 * 1024

function composerStatus(message) {
  const output = byId('chat-composer-status')
  output.textContent = message
  output.hidden = !message
}

function renderComposerControls() {
  const hasContent = composer.elements.body.value.trim() || pendingAttachments.length
  const send = byId('chat-send')
  send.hidden = Boolean(recording) || !hasContent
  send.disabled = sendingChat
  recordingButton.hidden = !recording && Boolean(hasContent)
  byId('chat-camera').hidden = Boolean(recording || hasContent)
  byId('chat-camera').disabled = sendingChat
  recordingButton.disabled = sendingChat
  const label = recording ? 'Parar gravação' : 'Gravar áudio'
  recordingButton.title = label
  recordingButton.setAttribute('aria-label', label)
  recordingButton.querySelector('.voice-mic').toggleAttribute('hidden', Boolean(recording))
  recordingButton.querySelector('.voice-stop').toggleAttribute('hidden', !recording)
}
composer.elements.body.addEventListener('input', renderComposerControls)

function renderComposer() {
  preview.hidden = !pendingAttachments.length
  preview.replaceChildren(...pendingAttachments.map(item => {
    const card = element('article')
    const category = item.file.type.split('/')[0]
    if (['image', 'audio', 'video'].includes(category)) {
      const media = element(category === 'image' ? 'img' : category)
      media.src = item.url
      if (category === 'image') media.alt = 'Prévia de ' + item.file.name
      else { media.controls = true; media.preload = 'metadata' }
      card.append(media)
    }
    card.append(element('strong', item.file.name), element('small',
      new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(item.file.size / 1024) + ' KiB'))
    const remove = button('Remover', () => {
      pendingAttachments = pendingAttachments.filter(entry => entry !== item)
      URL.revokeObjectURL(item.url)
      renderComposer()
    })
    remove.disabled = sendingChat
    card.append(remove)
    return card
  }))
  renderComposerControls()
}

function resetChatComposer() {
  composerRevision++
  byId('wa-mention-list').hidden=true
  selectedMentions.clear()
  if (recording) {
    recording.discard = true
    if (recording.recorder.state !== 'inactive') recording.recorder.stop()
    recording = null
  }
  for (const item of pendingAttachments) URL.revokeObjectURL(item.url)
  pendingAttachments = []
  composer.reset()
  byId('attach-menu').open = false
  composerStatus('')
  renderComposer()
}

function addChatFiles(files, voice = false) {
  if (!model.chat || sendingChat) return
  const rejected = []
  for (const file of files) {
    if (!file.size || file.size > fileLimit || pendingAttachments.length >= 10) {
      rejected.push(file.name)
      continue
    }
    pendingAttachments.push({ file, voice, url: URL.createObjectURL(file) })
  }
  composerStatus(rejected.length ? 'Alguns arquivos não foram incluídos. Limite de 10 anexos de até 10 MiB cada.' : '')
  renderComposer()
}

for (const [id, accept] of [['attach-photos', 'image/*,video/*'], ['attach-files', '']]) {
  byId(id).onclick = () => {
    filesInput.accept = accept
    byId('attach-menu').open = false
    filesInput.click()
  }
}
const cameraInput = byId('camera-file')
byId('chat-camera').onclick = () => cameraInput.click()
cameraInput.onchange = () => { addChatFiles(cameraInput.files); cameraInput.value = '' }
filesInput.onchange = () => { addChatFiles(filesInput.files); filesInput.value = '' }

const threadPanel = byId('thread')
threadPanel.ondragover = event => {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  if (!composer.hidden) threadPanel.classList.add('chat-dragging')
}
threadPanel.ondragleave = event => {
  if (!threadPanel.contains(event.relatedTarget)) threadPanel.classList.remove('chat-dragging')
}
threadPanel.ondrop = event => {
  if (!event.dataTransfer.types.includes('Files')) return
  event.preventDefault()
  threadPanel.classList.remove('chat-dragging')
  if (!composer.hidden) addChatFiles(event.dataTransfer.files)
}

recordingButton.onclick = act(async () => {
  if (recording) {
    if (recording.recorder.state === 'recording') recording.recorder.stop()
    return
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Este navegador não oferece gravação de áudio.')
  const revision = composerRevision
  recordingButton.disabled = true
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (revision !== composerRevision) { stream.getTracks().forEach(track => track.stop()); return }
    try {
      const type = ['audio/ogg;codecs=opus','audio/webm;codecs=opus','audio/mp4'].find(value => MediaRecorder.isTypeSupported(value))
      if (!type) throw new Error('Este navegador não oferece um formato de áudio compatível.')
      const recorder = new MediaRecorder(stream, { mimeType: type })
      const current = { recorder, discard: false }
      const chunks = []
      recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data) }
      recorder.onstop = () => {
        clearTimeout(current.timer)
        stream.getTracks().forEach(track => track.stop())
        if (recording !== current) return
        recording = null
        composerStatus('')
        if (!current.discard) {
          const extension = type.includes('ogg') ? 'ogg' : type.includes('mp4') ? 'm4a' : 'webm'
          addChatFiles([new File(chunks, 'Gravação.' + extension, { type: recorder.mimeType })], true)
        }
        renderComposer()
      }
      recorder.start()
      current.timer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop() }, 5 * 60 * 1000)
      recording = current
      composerStatus('Gravando áudio…')
    } catch (failure) {
      stream.getTracks().forEach(track => track.stop())
      throw failure
    }
  } finally { renderComposer() }
})

function encodeChatFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = () => reject(new Error('Não foi possível ler o arquivo.'))
    reader.readAsDataURL(file)
  })
}

composer.elements.body.onkeydown = event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    composer.requestSubmit()
  }
}

composer.onsubmit = act(async () => {
  if (composer.hidden || sendingChat || recording || !model.chat) return
  const revision = composerRevision
  const {account,chat} = model
  let body = composer.elements.body.value
  const mentionIds = text => [...selectedMentions].filter(id=>text.split(/\s+/).includes('@'+id.split('@')[0]))
  const queued = [...pendingAttachments]
  if (!body.trim() && !queued.length) return
  sendingChat = true
  composer.elements.body.disabled = true
  renderComposer()
  composerStatus('Enviando…')
  try {
    if (!queued.length) {
      await sendFromComposer(account,chat, { body, mentions:mentionIds(body) })
    } else {
      for (const item of queued) {
        if (revision !== composerRevision) break
        if (item.voice && body.trim()) {
          await sendFromComposer(account,chat, { body, mentions:mentionIds(body) })
          body = ''
          if (revision !== composerRevision) break
          composer.elements.body.value = ''
        }
        const data = await encodeChatFile(item.file)
        if (revision !== composerRevision) break
        await sendFromComposer(account,chat, { body, mentions:mentionIds(body), voice: item.voice, file: { name: item.file.name, type: item.file.type, data } })
        URL.revokeObjectURL(item.url)
        pendingAttachments = pendingAttachments.filter(entry => entry !== item)
        body = ''
        if (revision === composerRevision) composer.elements.body.value = ''
      }
    }
    if (revision === composerRevision) {
      resetChatComposer()
      model.source = null
      void refresh().catch(failure => error(failure.message))
    }
  } catch (failure) {
    if (revision === composerRevision) composerStatus(failure.message)
    else throw failure
  } finally {
    sendingChat = false
    composer.elements.body.disabled = false
    renderComposer()
  }
})

function renderSelection() {
  byId('message-selection').hidden = !selectedMessages.size
  byId('selection-count').textContent = selectedMessages.size + (selectedMessages.size === 1 ? ' selecionada' : ' selecionadas')
}

function redrawSelection() {
  chatStamp = ''
  const account = model.accounts.find(item => item.id === model.account)
  if (account) renderChat(account)
  else renderSelection()
}

function toggleMessage(id) {
  if (selectedMessages.has(id)) selectedMessages.delete(id)
  else {
    if (selectedMessages.size >= 30) throw new Error('Selecione até 30 mensagens.')
    selectedMessages.add(id)
  }
  redrawSelection()
}

const messageActions = byId('message-actions')
let actionTrigger

function closeMessageActions() {
  if (messageActions.matches(':popover-open')) messageActions.hidePopover()
}
messageActions.addEventListener('beforetoggle', event => {
  if (event.newState === 'closed') actionTrigger?.setAttribute('aria-expanded', 'false')
})
document.addEventListener('scroll', event => {
  if (event.target !== messageActions) closeMessageActions()
}, true)
window.addEventListener('resize', closeMessageActions)

// A touch hold opens the same actions as the keyboard-accessible button.
const messageList = byId('messages')
let hold
function cancelHold() {
  if (hold) clearTimeout(hold.timer)
  hold = null
}
function touchMenu(target) {
  if (target.closest('a,button,input,summary,audio,video,[role="button"]')) return
  return target.closest('.message')?.querySelector('.message-action-trigger')
}
messageList.addEventListener('pointerdown',event => {
  cancelHold()
  if (event.pointerType !== 'touch' || !event.isPrimary) return
  const trigger = touchMenu(event.target)
  if (!trigger) return
  hold = {x:event.clientX,y:event.clientY,timer:setTimeout(() => {
    if (trigger.isConnected) trigger.click()
    cancelHold()
  },500)}
})
messageList.addEventListener('pointermove',event => {
  if (hold && Math.hypot(event.clientX-hold.x,event.clientY-hold.y)>8) cancelHold()
})
for (const type of ['pointerup','pointercancel','scroll']) messageList.addEventListener(type,cancelHold)
messageList.addEventListener('contextmenu',event => {
  const trigger = mobileChat.matches && touchMenu(event.target)
  if (!trigger) return
  event.preventDefault()
  cancelHold()
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click()
})

function messageMenu(account, chat, message, online) {
  const trigger = button('', () => {
    const wasOpen = actionTrigger === trigger && messageActions.matches(':popover-open')
    closeMessageActions()
    if (wasOpen) return
    actionTrigger = trigger
    messageActions.replaceChildren()
    const addAction = (label, handler) => {
      messageActions.append(button(label, () => {
        closeMessageActions()
        return handler()
      }))
    }
    if ((online || deviceMode) && message.media) {
      const download = element('a', 'Baixar anexo')
      download.href = accountUrl(account) + '/media/' + pathPart(message.id)
      download.download = ''
      download.onclick = closeMessageActions
      messageActions.append(download)
    }
    if (online) addAction('Responder com I.A.', () => openAiReply(account, chat, message))
    if (message.body || message.transcript) addAction('Copiar mensagem', async () => {
      await navigator.clipboard.writeText(message.body || message.transcript)
      composerStatus('Mensagem copiada.')
    })
    if (online) {
      const launch = operation => openWhatsAppActions({account, chat, message:message.id, operation})
      addAction('Reagir', () => launch('message.react'))
      addAction('Responder citando', () => launch('message.reply'))
      if (message.poll) addAction('Votar', () => launch('message.vote'))
      addAction('Apagar…', () => openChatBatch('delete', [message.id]))
      addAction('Outras ações do WhatsApp', () => launch('message.getInfo'))
      addAction('Encaminhar', () => openChatBatch('forward', [message.id]))
      addAction('Selecionar', () => toggleMessage(message.id))
    }
    messageActions.showPopover()
    trigger.setAttribute('aria-expanded', 'true')
    const edge = 6
    const rect = trigger.getBoundingClientRect()
    const left = Math.max(edge, Math.min(rect.right - messageActions.offsetWidth, window.innerWidth - messageActions.offsetWidth - edge))
    const top = rect.bottom + messageActions.offsetHeight + edge <= window.innerHeight ? rect.bottom : rect.top - messageActions.offsetHeight
    messageActions.style.left = left + 'px'
    messageActions.style.top = Math.max(edge, top) + 'px'
    messageActions.firstElementChild.focus({ preventScroll: true })
  })
  trigger.className = 'message-action-trigger'
  trigger.setAttribute('aria-label', 'Opções da mensagem')
  trigger.setAttribute('aria-expanded', 'false')
  trigger.setAttribute('aria-controls', 'message-actions')
  trigger.popoverTargetElement = messageActions
  return trigger
}

const batchDialog = byId('chat-batch-dialog')
const batchForm = byId('chat-batch-form')
let batch

async function openChatBatch(action, ids) {
  const operation = { action, ids, account: model.account, chat: model.chat }
  batch = operation
  const forward = action === 'forward'
  byId('batch-delete-scope').hidden = forward
  batchForm.elements.deleteScope.value = 'delete'
  const select = batchForm.elements.destination
  const submit = byId('chat-batch-confirm')
  byId('chat-batch-title').textContent = forward ? 'Encaminhar mensagens' : 'Apagar mensagens'
  byId('chat-batch-detail').textContent = ids.length + (ids.length === 1 ? ' mensagem selecionada.' : ' mensagens selecionadas.') +
    (forward ? '' : ' A exclusão vale para você.')
  byId('chat-batch-destination').hidden = !forward
  select.required = forward
  select.replaceChildren(new Option('Selecione uma conversa', ''))
  byId('chat-batch-status').textContent = ''
  submit.textContent = forward ? 'Encaminhar' : 'Apagar para mim'
  submit.disabled = forward
  batchDialog.showModal()
  if (forward) {
    try {
      const chats = await api(accountUrl(operation.account) + '/chats')
      if (batch !== operation || !batchDialog.open) return
      select.append(...chats.filter(chat => !/@(?:broadcast|newsletter)$/.test(chat.id)).map(chat => new Option(chat.name, chat.id)))
      submit.disabled = select.options.length === 1
      if (submit.disabled) byId('chat-batch-status').textContent = 'Nenhuma conversa de destino disponível.'
    } catch (failure) { byId('chat-batch-status').textContent = failure.message }
  }
}
batchForm.elements.deleteScope.onchange = () => {
  if (!batch) return
  batch.action = batchForm.elements.deleteScope.value
  const everyone = batch.action === 'deleteEveryone'
  byId('chat-batch-confirm').textContent = everyone ? 'Apagar para todos' : 'Apagar para mim'
  byId('chat-batch-detail').textContent = batch.ids.length + (batch.ids.length === 1 ? ' mensagem selecionada.' : ' mensagens selecionadas.') +
    (everyone ? ' O WhatsApp verificará a permissão de revogar cada mensagem.' : ' A exclusão vale para você.')
}
byId('chat-batch-close').onclick = () => batchDialog.close()
byId('selection-clear').onclick = () => { selectedMessages.clear(); redrawSelection() }
function orderedSelection() { return model.messages.filter(item => selectedMessages.has(item.id)).map(item => item.id) }
byId('selection-forward').onclick = act(() => openChatBatch('forward', orderedSelection()))
byId('selection-delete').onclick = act(() => openChatBatch('delete', orderedSelection()))
batchForm.onsubmit = async event => {
  event.preventDefault()
  const operation = batch
  const submit = byId('chat-batch-confirm')
  if (!operation || submit.disabled) return
  const status = byId('chat-batch-status')
  submit.disabled = true
  byId('chat-batch-close').disabled = true
  try {
    const { results } = await api(chatUrl(operation.account, operation.chat) + '/messages/batch', 'POST',
      { action: operation.action, ids: operation.ids, destination: batchForm.elements.destination.value })
    const successful = results.filter(result => result.ok)
    operation.ids = results.filter(result => !result.ok).map(result => result.id)
    if (model.account === operation.account && model.chat === operation.chat) {
      for (const item of successful) selectedMessages.delete(item.id)
      if (operation.action === 'delete') model.messages = model.messages.filter(message => !successful.some(item => item.id === message.id))
      redrawSelection()
      await refresh()
    }
    if (!operation.ids.length) batchDialog.close()
    else {
      status.textContent = successful.length + ' concluída(s), ' + operation.ids.length + ' sem confirmação. Confira a conversa antes de repetir.'
      submit.disabled = true
    }
  } catch (failure) {
    status.textContent = failure.message
  } finally { byId('chat-batch-close').disabled = false }
}
batchDialog.oncancel = event => { if (byId('chat-batch-close').disabled) event.preventDefault() }

show('chat')
const poll = () => refresh().catch(failure => error(failure.message))
poll()
setInterval(poll, 3000)
window.addEventListener('online',poll)
window.addEventListener('offline',() => { deviceMode = true; poll() })
