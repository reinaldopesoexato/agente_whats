(() => {
  const button=document.getElementById('install-app'), help=document.getElementById('install-help')
  let prompt
  const standalone=matchMedia('(display-mode: standalone)')
  const apple=/iPhone|iPad|iPod/.test(navigator.userAgent) || navigator.platform==='MacIntel' && navigator.maxTouchPoints>1
  const mobile=apple || /Android/.test(navigator.userAgent)
  function render(){button.hidden=!window.isSecureContext || standalone.matches || navigator.standalone || (!mobile&&!prompt)}
  window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();prompt=event;render()})
  window.addEventListener('appinstalled',()=>{prompt=null;button.hidden=true;help.textContent='WhatsIA instalado.'})
  button.onclick=async()=>{
    if (prompt) {const choice=prompt;prompt=null;await choice.prompt();await choice.userChoice;render();return}
    help.textContent=apple?'No Safari, toque em Compartilhar e em Adicionar à Tela de Início. Abra o WhatsIA pelo novo ícone.':
      'No menu do Chrome, toque em Instalar aplicativo ou Adicionar à tela inicial.'
  }
  const logout=document.getElementById('mobile-logout')
  logout.hidden=!(standalone.matches || navigator.standalone) || !/^[a-f0-9-]{36}\./.test(location.hostname)
  logout.onclick=async()=>{
    try {
      if (await offlineChat.pending().then(rows=>rows.length).catch(()=>0) &&
          !confirm('Sair e remover as mensagens pendentes deste aparelho?')) return
      const answer=await fetch('/_mobile-logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})
      if (!answer.ok) throw Error()
      await offlineChat.clear()
      await caches.delete('whatsia-shell-offline-1')
      location.replace('/?app=1')
    } catch {help.textContent='Não foi possível sair. Confira a conexão e tente novamente.'}
  }
  render()
  if ('serviceWorker' in navigator && window.isSecureContext) {
    const prepare = () => navigator.serviceWorker.ready.then(reg=>reg.active?.postMessage({action:'prepare-offline'}))
    navigator.serviceWorker.register('/notification-worker.js').then(prepare).catch(()=>{})
    navigator.serviceWorker.addEventListener('controllerchange',prepare)
    window.addEventListener('online',prepare)
  }
})()
