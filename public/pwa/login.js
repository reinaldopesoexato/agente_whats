document.querySelector('form').onsubmit=async event=>{
  event.preventDefault()
  const form=event.target
  form.querySelector('button').disabled=true
  try {
    const res=await fetch('/_mobile-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.fromEntries(new FormData(form)))})
    if (!res.ok) throw new Error(res.status===429?'Aguarde antes de tentar novamente.':'Confira o e-mail e a senha deste espaço.')
    location.reload()
  } catch(e){document.querySelector('[role=status]').textContent=e.message}
  finally{form.querySelector('button').disabled=false}
}
