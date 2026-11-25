(() => {
  const form=document.getElementById('media-cleanup')
  const account=form.elements.account
  const preview=form.querySelector('[type=submit]')
  const remove=document.getElementById('clean-confirm')
  const feedback=document.getElementById('clean-feedback')
  let ticket,revision=0
  document.getElementById('archive-open').addEventListener('click',async()=>{
    const selected=account.value
    try {
      const response=await fetch('/api/accounts');if(!response.ok)return
      const accounts=await response.json()
      account.replaceChildren(new Option('Todas as contas',''),...accounts.map(a=>new Option(a.name,a.id)))
      account.value=selected
    } catch {}
  })
  form.oninput=()=>{revision++;ticket=null;remove.hidden=true;feedback.textContent=''}
  form.onsubmit=async event=>{
    event.preventDefault();const current=++revision;ticket=null;remove.hidden=true;preview.disabled=true
    try {
      const result=await api('/api/storage/preview','POST',{account:account.value,type:form.elements.type.value,days:form.elements.days.valueAsNumber},300000)
      if(current!==revision)return
      ticket=result.ticket
      feedback.textContent=result.count+' arquivo(s) · '+(result.bytes/1048576).toFixed(2)+' MiB'
      remove.hidden=!result.count
    } catch(e){feedback.textContent=e.message}finally{preview.disabled=false}
  }
  remove.onclick=async()=>{
    if(!ticket)return
    const current=ticket;ticket=null;remove.hidden=true
    try {
      const result=await api('/api/storage/clean','POST',{ticket:current},300000)
      feedback.textContent=result.count+' arquivo(s) removido(s) · '+(result.bytes/1048576).toFixed(2)+' MiB liberados.'
    }catch(e){feedback.textContent=e.message}
  }
  if(location.protocol==='https:'&&/^[a-f0-9-]{36}\./.test(location.hostname)) document.getElementById('portal-link').hidden=false
})()
