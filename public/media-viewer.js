// Media opened from the current conversation. All writes use an explicit account, chat and message.
(() => {
  const dialog = element('dialog')
  dialog.id = 'chat-media-viewer'
  dialog.setAttribute('aria-label','Mídias da conversa')
  dialog.innerHTML = `
    <div class="mv-header"><div class="mv-back"></div><div class="mv-author"></div><div class="mv-actions"></div></div>
    <div class="mv-stage"></div><div class="mv-tools" hidden></div>
    <p class="mv-caption" hidden></p><p class="mv-status" role="status" hidden></p>
    <div class="mv-footer"><button type="button" class="mv-all">Todas as mídias</button><div class="mv-strip"></div><div class="mv-quick"></div></div>`
  document.body.append(dialog)
  const part = name => dialog.querySelector('.mv-'+name)
  const stage = part('stage'), tools = part('tools'), actions = part('actions'), quick = part('quick')
  const paths = {
    back:'m15 4-8 8 8 8', next:'m9 4 8 8-8 8', share:'M12 15V2m-4 4 4-4 4 4M6 9H4v12h16V9h-2',
    more:'M4 12h.1m7.9 0h.1m7.9 0h.1', delete:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7',
    star:'m12 2 3 6.3 7 1-5 5 1.2 7-6.2-3.4-6.2 3.4 1.2-7-5-5 7-1z',
    edit:'m4 16 12-12 4 4L8 20l-5 1zM14 6l4 4',forward:'m14 4 8 7-8 7v-5c-6 0-9 3-12 7 1-8 4-12 12-12z',
    download:'M12 2v13m-5-5 5 5 5-5M3 15v6h18v-6',zoom:'M17 17l5 5M19 10a9 9 0 1 1-18 0 9 9 0 0 1 18 0M6 10h8m-4-4v8',
    react:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M7 14q5 6 10 0M8 8h.1m7.9 0h.1'
  }
  let view
  function status(text='') {
    part('status').textContent=text
    part('status').hidden=!text
  }
  function control(label,fn,icon) {
    const btn=element('button',icon?'':label)
    btn.type='button'
    btn.title=label
    btn.setAttribute('aria-label',label)
    if (icon) {
      const svg=document.createElementNS('http://www.w3.org/2000/svg','svg')
      svg.setAttribute('viewBox','0 0 24 24')
      svg.setAttribute('aria-hidden','true')
      const line=document.createElementNS(svg.namespaceURI,'path')
      line.setAttribute('d',paths[icon])
      svg.append(line);btn.append(svg)
    }
    btn.onclick=async()=>{
      const current=view
      if (!current || current.busy) return
      try { status();await fn() } catch(error) { if (view===current) status(error.message) }
      finally {
        if (dialog.matches(':modal') && document.activeElement===document.body) dialog.focus()
      }
    }
    return btn
  }
  const imageItem=m=>['image','sticker'].includes(m.type)
  const mediaUrl=(v,m,preview=true)=>accountUrl(v.account)+'/media/'+pathPart(m.id)+(preview?'?preview=1':'')
  function clearTools() { tools.replaceChildren();tools.hidden=true }
  function panel(...children) {tools.replaceChildren(...children);tools.hidden=false}
  function active(v,m){return view===v && v.current===m && dialog.open}
  function close() {
    if (!view || (view.busy && !view.paging)) return
    if (view.editor && !window.confirm('Descartar a edição desta imagem?')) return
    dialog.close()
  }
  dialog.addEventListener('cancel',e=>{e.preventDefault();close()})
  dialog.addEventListener('close',()=>{if(!dialog.open){view=null;stage.replaceChildren();clearTools();part('strip').replaceChildren()}})
  const back=control('Voltar',close,'back')
  back.onclick=close
  part('back').append(back)
  function download(v,m) {
    const a=element('a')
    a.href=mediaUrl(v,m,false);a.download='';a.click()
  }
  async function fileFor(v,m) {
    const response=await fetch(mediaUrl(v,m),{signal:AbortSignal.timeout(45000)})
    if (!response.ok) throw Error('O WhatsApp não disponibilizou esta mídia.')
    const blob=await response.blob()
    const ext=blob.type.split('/')[1]?.split(';')[0].replace(/[^a-z0-9]/gi,'') || 'bin'
    return new File([blob],m.filename || 'midia.'+ext,{type:blob.type})
  }
  async function copyImage(v,m) {
    if (!navigator.clipboard?.write || !window.ClipboardItem) throw Error('Este navegador não permite copiar imagens. Use Baixar.')
    const png=(async()=>{
      const file=await fileFor(v,m)
      const bitmap=await createImageBitmap(file)
      try {
        const c=element('canvas');c.width=bitmap.width;c.height=bitmap.height
        c.getContext('2d').drawImage(bitmap,0,0)
        return await canvasBlob(c,'image/png')
      } finally {bitmap.close()}
    })()
    await navigator.clipboard.write([new ClipboardItem({'image/png':png})])
    if(active(v,m))status('Imagem copiada.')
  }
  function canvasBlob(c,mime,quality){
    return new Promise((resolve,reject)=>c.toBlob(b=>b?resolve(b):reject(Error('Não foi possível preparar a imagem.')),mime,quality))
  }
  function share(v,m){
    // Prepare files before the native share click so transient user activation is available.
    panel(element('span','Preparando arquivo…'))
    return fileFor(v,m).then(file=>{
      if(!active(v,m) || v.editor)return
      const buttons=[]
      if(navigator.canShare?.({files:[file]})) buttons.push(control('Compartilhar arquivo…',async()=>{
        try{await navigator.share({files:[file]})}catch(e){if(e.name!=='AbortError')throw e}
      }))
      if(imageItem(m) && navigator.clipboard?.write)buttons.push(control('Copiar imagem',()=>copyImage(v,m)))
      buttons.push(control('Encaminhar no WhatsApp',()=>batch(v,m,'forward')),control('Baixar arquivo',()=>download(v,m)))
      panel(...buttons)
    })
  }
  function batch(v,m,action){
    if(model.account!==v.account || model.chat!==v.chat) throw Error('Reabra a imagem na conversa de origem.')
    dialog.close()
    return openChatBatch(action,[m.id])
  }
  async function action(v,m,operation,params={}) {
    v.busy=true
    try{return await waPost(v.account,{chat:v.chat,message:m.id,operation,params})}
    finally{v.busy=false}
  }
  function navigation(v,delta) {
    if(v.editor || v.gallery || v.busy)return
    const idx=v.items.findIndex(m=>m.id===v.current.id)
    if(v.items[idx+delta])show(v,v.items[idx+delta])
  }
  function thumb(v,m){
    const label=({image:'Imagem',sticker:'Figurinha',audio:'Áudio',ptt:'Mensagem de voz',video:'Vídeo',document:'Arquivo'})[m.type] || 'Anexo'
    const btn=control(label+' · '+new Date(m.timestamp).toLocaleString('pt-BR'),()=>show(v,m))
    btn.className='mv-thumb'
    if(m.id===v.current.id)btn.setAttribute('aria-current','true')
    if(imageItem(m)){
      const img=element('img');img.alt=label;img.loading='lazy';img.src=mediaUrl(v,m)
      btn.replaceChildren(img)
    }else btn.textContent=label
    return btn
  }
  function gallery(v){
    if(v.busy || v.editor)return
    v.gallery=true;clearTools();status()
    part('caption').hidden=true;actions.replaceChildren();quick.replaceChildren();part('strip').replaceChildren()
    part('author').replaceChildren(element('strong','Todas as mídias'),element('small',v.title))
    part('all').hidden=true
    stage.className='mv-stage mv-gallery'
    const grid=element('div');grid.className='mv-grid'
    const sorted=[...v.items].reverse()
    grid.append(...sorted.slice(0,v.limit).map(m=>thumb(v,m)))
    stage.replaceChildren(grid)
    if(sorted.length>v.limit || v.more)stage.append(control('Carregar mais mídias',async()=>{
      if(sorted.length<=v.limit){
        v.paging=true;v.busy=true
        try {
          status('Buscando mídias anteriores…')
          const seen=new Set(v.items.map(m=>m.id))
          let added=0
          while(v.more && v.cursor && !added && view===v){
            const query=new URLSearchParams({page:'1',before:v.cursor.timestamp,beforeId:v.cursor.id})
            const page=await api(chatUrl(v.account,v.chat)+'?'+query,'GET',undefined,35000)
            for(const m of page.messages)if(m.media && !m.revoked && !seen.has(m.id)){seen.add(m.id);v.items.push(m);added++}
            v.more=page.hasMore && page.next && (page.next.id!==v.cursor.id || page.next.timestamp!==v.cursor.timestamp)
            v.cursor=page.next
          }
          v.items.sort((a,b)=>a.timestamp-b.timestamp || a.id.localeCompare(b.id))
        }finally{v.busy=false;v.paging=false}
      }
      if(view===v && dialog.open){v.limit+=48;gallery(v)}
    }))
    quick.append(control('Voltar à mídia',()=>show(v,v.current)))
  }
  function toggleZoom(v){
    if(!v.photo || !v.photo.naturalWidth)return
    stage.classList.toggle('mv-zoom')
    if(stage.classList.contains('mv-zoom'))v.photo.style.width=Math.max(stage.clientWidth*1.6,v.photo.naturalWidth)+'px'
    else v.photo.style.removeProperty('width')
  }
  function show(v,m){
    if(view!==v || v.busy)return
    v.current=m;v.gallery=false;v.editor=null;v.photo=null
    clearTools();status()
    stage.className='mv-stage'
    stage.replaceChildren()
    const name=m.fromMe?'Você':m.senderName || v.title
    const author=element('div')
    author.append(element('strong',name),element('small',new Date(m.timestamp).toLocaleString('pt-BR',{dateStyle:'short',timeStyle:'short'})))
    part('author').replaceChildren(chatAvatar(v.account,{id:m.fromMe?null:m.sender || v.chat,name}),author)
    if(imageItem(m)){
      const img=element('img');img.alt=m.body || 'Imagem da conversa';img.src=mediaUrl(v,m)
      img.onerror=()=>{if(active(v,m))status('Imagem indisponível no WhatsApp.')}
      img.draggable=false
      img.ondblclick=()=>toggleZoom(v)
      let drag
      img.onpointerdown=e=>{
        if(e.button!==0)return
        drag={x:e.clientX,y:e.clientY,left:stage.scrollLeft,top:stage.scrollTop}
        img.setPointerCapture(e.pointerId)
      }
      img.onpointermove=e=>{
        if(!drag || !stage.classList.contains('mv-zoom'))return
        stage.scrollTo(drag.left+drag.x-e.clientX,drag.top+drag.y-e.clientY)
      }
      img.onpointerup=e=>{
        if(drag && e.pointerType==='touch' && !stage.classList.contains('mv-zoom')){
          const dx=e.clientX-drag.x
          if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(e.clientY-drag.y)*1.5)navigation(v,dx<0?1:-1)
        }
        drag=null
      }
      img.onpointercancel=()=>{drag=null}
      v.photo=img;stage.append(img)
    }else if(['ptt','audio','video'].includes(m.type)){
      const player=element(m.type==='video'?'video':'audio')
      player.controls=true;player.src=mediaUrl(v,m);stage.append(player)
    }else stage.append(control('Baixar '+(m.filename || 'arquivo'),()=>download(v,m)))
    part('caption').textContent=m.body || ''
    part('caption').hidden=!m.body
    const index=v.items.indexOf(m)
    const arrows=[[-1,'Anterior','back'],[1,'Próxima','next']]
    for(const [delta,label,icon] of arrows)if(v.items[index+delta]){
      const btn=control(label,()=>navigation(v,delta),icon)
      btn.className=delta<0?'mv-prev':'mv-next';stage.append(btn)
    }
    const favorite=control(m.isStarred?'Retirar dos favoritos':'Favoritar',async()=>{
      await action(v,m,m.isStarred?'message.unstar':'message.star')
      m.isStarred=!m.isStarred
      if(active(v,m))show(v,m)
    },'star')
    favorite.setAttribute('aria-pressed',String(Boolean(m.isStarred)))
    actions.replaceChildren(control('Compartilhar',()=>share(v,m),'share'),control('Mais opções',()=>{
      const more=[control('Informações da mensagem',()=>openWhatsAppActions({account:v.account,chat:v.chat,message:m.id,operation:'message.getInfo',inspect:true})),
        control('Ir para a mensagem',()=>{dialog.close();return openChat(v.account,v.chat,m.id)})]
      if(imageItem(m))more.unshift(control('Ampliar ou reduzir',()=>{clearTools();toggleZoom(v)}),control('Copiar imagem',()=>copyImage(v,m)))
      panel(...more)
    },'more'),control('Apagar',()=>batch(v,m,'delete'),'delete'),favorite)
    if(imageItem(m))actions.append(control('Editar e reenviar',()=>edit(v,m),'edit'))
    actions.append(control('Encaminhar',()=>batch(v,m,'forward'),'forward'),control('Baixar',()=>download(v,m),'download'))
    part('all').hidden=false
    part('strip').replaceChildren(...v.items.slice(Math.max(0,index-5),index+6).map(item=>thumb(v,item)))
    quick.replaceChildren(control('Reagir',()=>{
      panel(...['👍','❤️','😂','😮','😢','🙏',''].map(emoji=>control(emoji || 'Retirar reação',async()=>{
        await action(v,m,'message.react',{emoji});clearTools();status('Reação atualizada.')
      })))
    },'react'),control('Responder',()=>{
      const field=element('input');field.placeholder='Responder citando esta mídia';field.setAttribute('aria-label','Resposta')
      const send=control('Enviar resposta',async()=>{
        if(!field.value.trim())throw Error('Escreva uma resposta.')
        await action(v,m,'message.reply',{text:field.value.trim()});clearTools();status('Resposta enviada.')
      })
      panel(field,send);field.onkeydown=e=>{if(e.key==='Enter' && !e.isComposing)send.click()};field.focus()
    }),control('OK',close))
  }
  function snapshot(canvas){
    const copy=element('canvas');copy.width=canvas.width;copy.height=canvas.height
    copy.getContext('2d').drawImage(canvas,0,0)
    return copy
  }
  function paint(canvas,op){
    const ctx=canvas.getContext('2d')
    if(op.type==='rotate' || op.type==='crop'){
      const prior=snapshot(canvas)
      if(op.type==='rotate'){
        canvas.width=prior.height;canvas.height=prior.width
        ctx.save();ctx.translate(canvas.width,0);ctx.rotate(Math.PI/2);ctx.drawImage(prior,0,0);ctx.restore()
      }else{
        canvas.width=op.w;canvas.height=op.h
        ctx.drawImage(prior,op.x,op.y,op.w,op.h,0,0,canvas.width,canvas.height)
      }
    }else if(op.type==='text'){
      ctx.save();ctx.font='bold '+op.size+'px system-ui';ctx.fillStyle=op.color
      ctx.textBaseline='top';ctx.fillText(op.text,op.x,op.y);ctx.restore()
    }else{
      ctx.save();ctx.strokeStyle=ctx.fillStyle=op.color;ctx.lineWidth=op.size
      ctx.lineCap=ctx.lineJoin='round';ctx.beginPath()
      const [start,...rest]=op.points
      if(rest.length){
        ctx.moveTo(start.x,start.y)
        for(const point of rest)ctx.lineTo(point.x,point.y)
        ctx.stroke()
      }else{ctx.arc(start.x,start.y,op.size/2,0,Math.PI*2);ctx.fill()}
      ctx.restore()
    }
  }
  async function edit(v,m){
    const img=v.photo
    if(!img?.naturalWidth)throw Error('Aguarde o carregamento da imagem.')
    const editor={ops:[],at:0,mode:'pen'}
    v.editor=editor;v.gallery=false
    stage.className='mv-stage mv-edit'
    const canvas=element('canvas')
    canvas.setAttribute('aria-label','Imagem em edição')
    stage.replaceChildren(canvas)
    part('caption').hidden=true;part('all').hidden=true;part('strip').replaceChildren()
    actions.replaceChildren();clearTools()
    const caption=element('textarea');caption.rows=1;caption.placeholder='Adicionar uma legenda…'
    caption.setAttribute('aria-label','Legenda da imagem');caption.value=m.body || ''
    const destination=element('select');destination.setAttribute('aria-label','Enviar para')
    destination.add(new Option(v.title,v.chat))
    const destinations=new Set([v.chat])
    function addDestination(row){
      if(!row.id || destinations.has(row.id) || /@(?:broadcast|newsletter)$/.test(row.id))return
      destinations.add(row.id)
      destination.add(new Option(row.name || row.id,row.id))
    }
    for(const row of model.chats)if(row.accountId===v.account)addDestination(row)
    api(accountUrl(v.account)+'/chats').then(rows=>{
      if(v.editor===editor && view===v)rows.forEach(addDestination)
    }).catch(()=>{})
    const color=element('input');color.type='color';color.value='#e53935';color.setAttribute('aria-label','Cor da anotação')
    const text=element('input');text.placeholder='Texto para inserir';text.setAttribute('aria-label',text.placeholder);text.hidden=true
    const size=element('select');size.setAttribute('aria-label','Espessura ou tamanho')
    for(const [name,val] of [['Fino',1],['Médio',2],['Grosso',4]])size.add(new Option(name,val))
    size.value='2'
    let gesture
    const modes=new Map()
    function mode(value){
      editor.mode=value;text.hidden=value!=='text'
      for(const [key,btn] of modes)btn.setAttribute('aria-pressed',String(value===key))
      status(value==='crop'?'Arraste para selecionar o recorte.':value==='text'?'Digite o texto e toque na imagem para posicioná-lo.':'')
    }
    for(const [key,label] of [['pen','Desenhar'],['text','Texto'],['crop','Recortar']]){
      const b=control(label,()=>mode(key));modes.set(key,b);actions.append(b)
    }
    function draw(){
      // Limit the working bitmap; caption-only sends keep the original file.
      const ratio=Math.min(1,3072/Math.max(img.naturalWidth,img.naturalHeight))
      canvas.width=Math.max(1,Math.round(img.naturalWidth*ratio))
      canvas.height=Math.max(1,Math.round(img.naturalHeight*ratio))
      canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height)
      for(const op of editor.ops.slice(0,editor.at))paint(canvas,op)
      undo.disabled=editor.at===0;redo.disabled=editor.at===editor.ops.length
    }
    function commit(op){
      editor.ops.splice(editor.at,Infinity,op);editor.at++;draw()
    }
    const undo=control('Desfazer',()=>{if(editor.at){editor.at--;draw()}})
    const redo=control('Refazer',()=>{if(editor.at<editor.ops.length){editor.at++;draw()}})
    actions.append(control('Girar 90°',()=>commit({type:'rotate'})),undo,redo)
    panel(color,size,text,caption,destination)
    quick.replaceChildren(control('Cancelar edição',()=>{
      if((editor.at || caption.value!==(m.body||'')) && !window.confirm('Descartar suas alterações?'))return
      show(v,m)
    }),control('Enviar imagem',async()=>{
      if(gesture || v.busy)return
      const target=destination.value,body=caption.value
      if(!target)throw Error('Escolha a conversa de destino.')
      v.busy=true;dialog.classList.add('mv-busy');status('Enviando imagem…')
      try{
        let file
        if(editor.at){
          let blob=await canvasBlob(canvas,'image/png')
          if(blob.size>10*1024*1024)blob=await canvasBlob(canvas,'image/webp',.88)
          file=new File([blob],'imagem-editada.'+(blob.type==='image/png'?'png':'webp'),{type:blob.type})
        }else file=await fileFor(v,m)
        if(file.size>10*1024*1024)throw Error('A imagem excede o limite de envio de 10 MiB.')
        const data=await encodeChatFile(file)
        await api(chatUrl(v.account,target),'POST',{body,file:{name:file.name,type:file.type,data}})
        v.editor=null;dialog.close()
        if(model.account===v.account && model.chat===target)latestMessages(model.accounts.find(a=>a.id===v.account),target).catch(e=>error(e.message))
      }finally{v.busy=false;dialog.classList.remove('mv-busy')}
    }))
    function point(e){
      const rect=canvas.getBoundingClientRect()
      return {x:Math.max(0,Math.min(canvas.width,(e.clientX-rect.left)*canvas.width/rect.width)),
        y:Math.max(0,Math.min(canvas.height,(e.clientY-rect.top)*canvas.height/rect.height))}
    }
    canvas.onpointerdown=e=>{
      if(gesture || e.button!==0 || v.busy)return
      const p=point(e),scale=canvas.width/canvas.getBoundingClientRect().width
      if(editor.mode==='text'){
        if(!text.value.trim()){text.focus();return}
        commit({type:'text',...p,text:text.value.trim(),color:color.value,size:Math.round((12+4*Number(size.value))*scale)})
        return
      }
      canvas.setPointerCapture(e.pointerId)
      gesture={id:e.pointerId,type:editor.mode,color:color.value,size:Math.max(1,Number(size.value)*1.5*scale),points:[p]}
      if(editor.mode==='pen')paint(canvas,gesture)
      else gesture.base=snapshot(canvas)
    }
    canvas.onpointermove=e=>{
      if(!gesture || gesture.id!==e.pointerId)return
      const p=point(e),start=gesture.points[0]
      if(gesture.type==='pen'){
        paint(canvas,{...gesture,points:[gesture.points.at(-1),p]});gesture.points.push(p)
      }else{
        const ctx=canvas.getContext('2d');ctx.clearRect(0,0,canvas.width,canvas.height);ctx.drawImage(gesture.base,0,0)
        ctx.save();ctx.lineWidth=gesture.size;ctx.strokeStyle='#178a54';ctx.setLineDash([gesture.size*3,gesture.size*2]);ctx.strokeRect(start.x,start.y,p.x-start.x,p.y-start.y);ctx.restore()
      }
    }
    canvas.onpointerup=e=>{
      if(!gesture || gesture.id!==e.pointerId)return
      const op=gesture;gesture=null
      if(op.type==='pen'){op.points.push(point(e));commit(op)}
      else{
        const a=op.points[0],b=point(e),w=Math.round(Math.abs(a.x-b.x)),h=Math.round(Math.abs(a.y-b.y))
        if(w>2 && h>2)commit({type:'crop',x:Math.floor(Math.min(a.x,b.x)),y:Math.floor(Math.min(a.y,b.y)),w,h})
        else draw()
      }
    }
    canvas.onpointercancel=()=>{gesture=null;draw()}
    mode('pen');draw()
  }
  part('all').onclick=()=>{if(view && !view.busy)gallery(view)}
  dialog.onkeydown=e=>{
    if(!view || view.busy || view.editor || /INPUT|SELECT|TEXTAREA/.test(e.target.tagName))return
    if(e.key==='ArrowLeft' || e.key==='ArrowRight'){e.preventDefault();navigation(view,e.key==='ArrowLeft'?-1:1)}
  }
  window.openChatMedia=(account,chat,message,title)=>{
    if(dialog.open)return
    const items=model.messages.filter(m=>m.media && !m.revoked)
    if(!items.some(m=>m.id===message.id))items.push(message)
    view={account,chat,title,items,current:message,cursor:historyWindow.next,more:Boolean(historyWindow.more && historyWindow.next),limit:48}
    dialog.showModal();show(view,message)
  }
})()
