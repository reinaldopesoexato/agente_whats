(() => {
  const form = byId('ai-preferences')
  const status = byId('ai-pref-status')
  const submit = form.querySelector('[type=submit]')
  let initial
  let visit = 0
  function fill(config) {
    initial = config
    byId('ai-inherit').hidden=!config.managedModels
    for (const [key, value] of Object.entries(config)) {
      if (form.elements[key]) form.elements[key].value = value
    }
    form.elements.apiKey.value = ''
    form.elements.removeKey.checked = false
    form.elements.apiKey.disabled = false
    form.elements.removeKey.disabled = !config.hasApiKey || config.useBroker
    byId('ai-key-state').textContent = config.useBroker ? 'Usando a chave compartilhada.' : config.hasApiKey ? 'Chave pessoal configurada.' : 'Nenhuma chave configurada.'
  }
  form.elements.removeKey.onchange = () => {
    form.elements.apiKey.disabled = form.elements.removeKey.checked
    if (form.elements.removeKey.checked) form.elements.apiKey.value = ''
  }
  function accountControls(accounts) {
    const rows = accounts.map(account => {
      const label = element('label', account.name)
      const select = element('select')
      select.append(new Option('Desativada', 'off'), new Option('Somente Ollama', 'local'), new Option('Híbrida · OpenAI', 'cloud'))
      select.value = account.mode
      select.onchange = async () => {
        select.disabled = true
        const mode = select.value
        try {
          await api(accountUrl(account.id), 'PATCH', { mode })
          account.mode = mode
          status.textContent = 'Análise de ' + account.name + ' atualizada.'
        } catch (failure) { select.value = account.mode; status.textContent = failure.message }
        finally { select.disabled = false }
      }
      label.append(select)
      return label
    })
    byId('ai-account-modes').replaceChildren(...rows)
    byId('ai-account-controls').hidden = !rows.length
  }
  byId('open-ai-settings').onclick = act(async () => {
    const current = ++visit
    byId('accounts-drawer').close()
    show('ai-settings')
    byId('ai-settings-title').focus()
    form.reset()
    initial = null
    submit.disabled = true
    status.textContent = 'Carregando configurações…'
    accountControls(model.accounts)
    api('/api/ai/local-models').then(({ models }) => {
      if (current === visit) byId('ollama-models').replaceChildren(...models.map(name => new Option(name)))
    }).catch(() => {})
    try {
      const config = await api('/api/ai/settings')
      if (current !== visit || model.tab !== 'ai-settings') return
      fill(config)
      status.textContent = ''
      submit.disabled = false
    } catch (failure) { status.textContent = 'Falha ao carregar as configurações. ' + failure.message }
  })
  byId('ai-inherit').onclick=act(async()=>{
    const models=Object.keys(initial).filter(key=>key.endsWith('Model') && key!=='whisperModel')
    fill(await api('/api/ai/settings','PATCH',Object.fromEntries(models.map(key=>[key,null]))))
    status.textContent='Modelos padrão aplicados.'
  })
  form.onsubmit = async event => {
    event.preventDefault()
    if (!initial || submit.disabled) return
    const current = visit
    const changes = {}
    for (const key of Object.keys(initial)) {
      const input = form.elements[key]
      if (!input) continue
      const value = input.type === 'number' ? input.valueAsNumber : input.value.trim()
      if (value !== initial[key]) changes[key] = value
    }
    const newKey = form.elements.apiKey.value.trim()
    if (newKey || form.elements.removeKey.checked) changes.apiKey = newKey
    submit.disabled = true
    status.textContent = 'Salvando…'
    try {
      const config = await api('/api/ai/settings', 'PATCH', changes)
      if (visit !== current || model.tab !== 'ai-settings') return
      fill(config)
      status.textContent = 'Configurações salvas.'
    } catch (failure) { status.textContent = failure.message }
    finally { if (visit === current) submit.disabled = false }
  }
})()
