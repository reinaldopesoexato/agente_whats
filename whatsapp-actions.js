const { MessageMedia, Location, Poll, ScheduledEvent } = require('whatsapp-web.js')

const fail = text => { throw Object.assign(new Error(text), { status: 422 }) }
const wid = id => typeof id === 'string' ? id : id?._serialized || id?.$1
const actions = new Map()
function define(scope, name, label, fields, apply, read = false) {
  const id = scope + '.' + name
  actions.set(id, { id, scope, label, fields: fields.split(' ').filter(Boolean), apply, read })
}
function method(scope, name, label, fields = '', read = false) {
  define(scope, name, label, fields, (target, p) => target[name](...fields.split(' ').filter(Boolean).map(key => p[key])), read)
}

const fieldTypes = {
  text:'Texto', title:'Nome ou título', description:'Descrição', emoji:'Reação (emoji)', users:'Participantes ou contatos',
  groups:'Grupos mencionados', to:'Conversa de destino (ID)', user:'Contato (telefone ou ID)', code:'Código ou link de convite',
  latitude:'Latitude', longitude:'Longitude', options:'Opções da enquete (uma por linha)', votes:'Opções votadas (uma por linha)',
  multiple:'Permitir várias respostas', enabled:'Ativar', file:'Arquivo', days:'Duração em dias', channel:'ID do canal',
  labels:'IDs de etiquetas (um por linha)', label:'ID da etiqueta', number:'Telefone com DDI', first:'Nome', last:'Sobrenome',
  when:'Data e hora', callType:'Tipo de chamada', choice:'Opção numérica', limit:'Limite', query:'Busca', broadcast:'ID da transmissão', call:'ID da chamada', statusMessage:'ID da mensagem de status'
}
const optional = new Set(['description','last','emoji','votes','labels'])
const ids = (value, kind) => {
  const parts = Array.isArray(value) ? value : String(value || '').split(/[\s,;]+/).filter(Boolean)
  return [...new Set(parts.map(raw => {
    const s = String(raw).trim()
    if (kind === 'groups' && /^[\d-]+@g\.us$/.test(s)) return s
    if (kind === 'users' && /^\d+@(c\.us|lid)$/.test(s)) return s
    if (kind === 'users' && /^\+?\d{5,18}$/.test(s)) return s.replace(/^\+/, '') + '@c.us'
    return fail('Identificador de contato ou grupo inválido.')
  }))]
}
function validate(id, params = {}) {
  const action = actions.get(id)
  if (!action) fail('Escolha uma ação disponível do WhatsApp.')
  const p = {}
  for (const key of action.fields) {
    const value = params?.[key]
    if (key === 'file') {
      if (typeof value?.data !== 'string' || !value.data.length || value.data.length > 13981016 || Buffer.byteLength(value.data,'base64') > 10*1024*1024 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data) || !/^[\w.+-]+\/[\w.+-]+$/.test(value.mime || '')) fail('Arquivo inválido ou maior que 10 MiB.')
      p.file = { mime: value.mime, data: value.data, name: String(value.name || 'anexo').split(/[\\/]/).pop().slice(0,180) }
    } else if (['multiple','enabled'].includes(key)) {
      if (value !== true && value !== false) fail('Informe ' + fieldTypes[key] + '.')
      p[key] = value
    } else if (['users','groups','user'].includes(key)) {
      const list = ids(value, key === 'user' ? 'users' : key)
      if (list.length > 256 || !list.length || (key === 'user' && list.length !== 1)) fail('Confira os destinatários selecionados.')
      p[key] = key === 'user' ? list[0] : list
    } else if (['options','votes','labels'].includes(key)) {
      const list = Array.isArray(value) ? value : String(value || '').split('\n')
      if (list.some(v => typeof v !== 'string')) fail('Lista inválida.')
      p[key] = [...new Set(list.map(s => s.trim()).filter(Boolean))]
      if (key === 'options' && (p[key].length < 2 || p[key].length > 12)) fail('Informe entre 2 e 12 opções.')
    } else if (['latitude','longitude','days','choice','limit'].includes(key)) {
      const n = Number(value)
      const ranges = {latitude:[-90,90],longitude:[-180,180],days:[1,3650],choice:[0,3],limit:[1,1000]}
      const [low, high] = ranges[key]
      if (value == null || value === '' || !Number.isFinite(n) || n < low || n > high || (!['latitude','longitude'].includes(key) && !Number.isInteger(n))) fail('Confira ' + fieldTypes[key] + '.')
      p[key] = n
    } else {
      const s = typeof value === 'string' ? value.trim() : ''
      if ((!s && !optional.has(key)) || s.length > 16000) fail('Confira ' + fieldTypes[key] + '.')
      if (key === 'when' && !Number.isFinite(Date.parse(s))) fail('Data inválida.')
      if (key === 'callType' && !['voice','video'].includes(s)) fail('Escolha voz ou vídeo.')
      if (key === 'emoji' && s && ([...new Intl.Segmenter().segment(s)].length !== 1 || !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(s))) fail('Escolha um único emoji.')
      p[key] = key === 'code' ? s.replace(/^https:\/\/(?:chat\.whatsapp\.com\/|whatsapp\.com\/channel\/)/i,'') : s
    }
  }
  return p
}
const media = file => new MessageMedia(file.mime, file.data, file.name)
async function send(ctx, content, options = {}) {
  const sent = await ctx.send(ctx.chat, content, { ...options, waitUntilMsgSent: true, sendSeen: false })
  if (!wid(sent?.id)) fail('Envio sem confirmação. Confira a conversa antes de repetir.')
  return sent
}
define('chat','text','Enviar texto','text',(_,p,c)=>send(c,p.text))
define('chat','mentions','Mencionar participantes','text users',(_,p,c)=>send(c,withMentions(p.text,p.users),{mentions:p.users}))
define('chat','mentionGroups','Mencionar grupos','text groups',async (_,p,c)=>{
  const mentions = []
  for (const id of p.groups) {
    const group = await c.client.getChatById(id)
    if (!group?.isGroup) fail('Grupo mencionado indisponível.')
    mentions.push({ id, subject:group.name })
  }
  return send(c,withMentions(p.text,p.groups),{groupMentions:mentions})
})
function withMentions(text, ids) {
  const tags = ids.map(id=>'@'+id.split('@')[0]).filter(tag=>!text.split(/\s+/).includes(tag))
  return [text,...tags].join(' ')
}
define('chat','media','Enviar mídia','file description',(_,p,c)=>send(c,media(p.file),{caption:p.description}))
define('chat','document','Enviar arquivo como documento','file description',(_,p,c)=>send(c,media(p.file),{sendMediaAsDocument:true,caption:p.description}))
define('chat','sticker','Enviar figurinha','file',(_,p,c)=>send(c,media(p.file),{sendMediaAsSticker:true}))
define('chat','voice','Enviar áudio de voz','file',(_,p,c)=>send(c,media(p.file),{sendAudioAsVoice:true}))
define('chat','contacts','Enviar cartões de contato','users',async (_,p,c)=>send(c,await Promise.all(p.users.map(id=>c.client.getContactById(id)))))
define('chat','location','Enviar localização','latitude longitude description',(_,p,c)=>send(c,new Location(p.latitude,p.longitude,{name:p.description})))
define('chat','poll','Criar enquete','title options multiple',(_,p,c)=>send(c,new Poll(p.title,p.options,{allowMultipleAnswers:p.multiple})))
define('chat','event','Criar evento','title when description',(_,p,c)=>send(c,new ScheduledEvent(p.title,new Date(p.when),{description:p.description})))
define('message','reply','Responder citando','text',(_,p,c)=>send(c,p.text,{quotedMessageId:c.message,ignoreQuoteErrors:false}))
define('message','react','Reagir ou retirar reação','emoji',(msg,p)=>msg.react(p.emoji))
define('message','deleteMe','Apagar para mim','',(msg,p,c)=>c.deleteMe(msg))
define('message','deleteEveryone','Apagar para todos','',(_,p,c)=>revokeEveryone(c.client,c.message))
define('message','forward','Encaminhar','to',(msg,p,c)=>c.forward(msg,p.to))
method('message','getReactions','Ver reações e participantes','',true)
method('message','getInfo','Ver informações de entrega e leitura','',true)
method('message','getMentions','Ver contatos mencionados','',true)
method('message','getGroupMentions','Ver grupos mencionados','',true)
method('message','getQuotedMessage','Ver mensagem citada','',true)
method('message','getPollVotes','Consultar votos','',true)
define('message','vote','Votar na enquete','votes',(m,p)=>{
  if ((!m.allowMultipleAnswers && p.votes.length > 1) || !m.pollOptions || p.votes.some(v=>!m.pollOptions.some(opt=>opt.name===v))) fail('Escolha opções existentes na enquete.')
  return m.vote(p.votes)
})
method('message','edit','Editar texto','text')
method('message','star','Favoritar'); method('message','unstar','Retirar favorito')
define('message','pin','Fixar mensagem','days',(m,p)=>m.pin(p.days*86400))
method('message','unpin','Desafixar mensagem')
method('message','acceptGroupV4Invite','Aceitar convite da mensagem')
method('message','getOrder','Consultar pedido','',true); method('message','getPayment','Consultar pagamento','',true)
define('message','respondEvent','Responder ao evento (0–3)','choice',(_,p,c)=>c.client.sendResponseToScheduledEvent(p.choice,c.message))
define('message','editEvent','Editar evento','title when description',(m,p)=>m.editScheduledEvent(new ScheduledEvent(p.title,new Date(p.when),{description:p.description})))
define('message','media','Baixar mídia','',async m=>{
  const f=await m.downloadMedia()
  if (!f?.data || f.data.length>13981016) fail('Mídia indisponível ou maior que 10 MiB.')
  return {download:{data:f.data,mime:f.mimetype,name:f.filename||'anexo'}}
},true)
define('chat','mute','Silenciar conversa','days',(chat,p)=>chat.mute(new Date(Date.now()+p.days*86400000)))
for (const [id,label] of Object.entries({unmute:'Reativar notificações',archive:'Arquivar',unarchive:'Desarquivar',pin:'Fixar conversa',unpin:'Desafixar conversa',markUnread:'Marcar como não lida',sendSeen:'Marcar como lida',syncHistory:'Sincronizar histórico',clearMessages:'Limpar mensagens da conversa',delete:'Apagar conversa',sendStateTyping:'Indicar digitação',sendStateRecording:'Indicar gravação',clearState:'Limpar indicação de atividade'})) method('chat',id,label)
method('chat','getPinnedMessages','Listar mensagens fixadas','',true)
method('chat','getLabels','Ver etiquetas','',true);method('chat','changeLabels','Alterar etiquetas','labels')
method('chat','getCustomerNote','Ler nota do cliente','',true);method('chat','addOrEditCustomerNote','Editar nota do cliente','text')
define('chat','history','Consultar mensagens','limit',(chat,p)=>chat.fetchMessages({limit:p.limit}),true)
define('group','participants','Listar participantes','',async (g,p,c)=>{
  const members=g.participants.map(item=>({id:wid(item.id),admin:item.isAdmin,owner:item.isSuperAdmin}))
  const names=await c.client.pupPage.evaluate(ids=>{
    const store=window.require('WAWebCollections').Contact
    return ids.map(id=>{const contact=store.get(id);return contact?.name || contact?.pushname || ''})
  },members.map(member=>member.id)).catch(()=>[])
  return members.map((member,index)=>({...member,name:names[index] || ''}))
},true)
define('group','addParticipants','Adicionar participantes','users',(g,p)=>g.addParticipants(p.users,{autoSendInviteV4:false}))
for (const [id,label] of Object.entries({removeParticipants:'Remover participantes',promoteParticipants:'Promover a administrador',demoteParticipants:'Remover privilégio de administrador'})) define('group',id,label,'users',async (g,p,c)=>{
  const members = new Set(g.participants.map(part=>wid(part.id)))
  const missing = p.users.filter(user=>!members.has(user))
  const resolved = missing.length ? await c.client.getContactLidAndPhone(missing) : []
  const users = p.users.map(user=>members.has(user) ? user :
    [resolved[missing.indexOf(user)]?.lid,resolved[missing.indexOf(user)]?.pn].find(alias=>members.has(alias)))
  if (users.some(user=>!user)) fail('Escolha um participante atual do grupo.')
  return g[id]([...new Set(users)])
})
method('group','setSubject','Alterar nome do grupo','title');method('group','setDescription','Alterar descrição do grupo','description')
method('group','setMessagesAdminsOnly','Somente administradores enviam mensagens','enabled')
method('group','setInfoAdminsOnly','Somente administradores editam o grupo','enabled')
method('group','setAddMembersAdminsOnly','Somente administradores adicionam membros','enabled')
method('group','getInviteCode','Consultar código de convite','',true);method('group','revokeInvite','Renovar convite do grupo')
define('group','setPicture','Alterar foto do grupo','file',(g,p)=>g.setPicture(media(p.file)))
method('group','deletePicture','Remover foto do grupo');method('group','leave','Sair do grupo')
method('group','getGroupMembershipRequests','Consultar solicitações de entrada','',true)
for (const [id,label] of [['approveGroupMembershipRequests','Aprovar solicitações de entrada'],['rejectGroupMembershipRequests','Recusar solicitações de entrada']]) define('group',id,label,'users',(g,p)=>g[id]({requesterIds:p.users}))
define('contact','info','Informações do contato','',c=>({id:wid(c.id),name:c.name,pushname:c.pushname,number:c.number,isBusiness:c.isBusiness,isBlocked:c.isBlocked}),true)
for (const [id,label] of Object.entries({getAbout:'Ler recado do contato',getCommonGroups:'Consultar grupos em comum',getProfilePicUrl:'Consultar foto de perfil',getFormattedNumber:'Formatar telefone',getCountryCode:'Consultar código de país'})) method('contact',id,label,'',true)
method('contact','block','Bloquear contato');method('contact','unblock','Desbloquear contato')
method('account','acceptInvite','Entrar no grupo por convite','code');method('account','getInviteInfo','Consultar convite de grupo','code',true)
define('account','createGroup','Criar grupo','title users',(c,p)=>c.createGroup(p.title,p.users,{autoSendInviteV4:false}))
method('account','setStatus','Alterar recado do perfil','text');method('account','setDisplayName','Alterar nome do perfil','title')
define('account','setProfilePicture','Alterar foto do perfil','file',(c,p)=>c.setProfilePicture(media(p.file)))
method('account','deleteProfilePicture','Remover foto do perfil')
for (const [id,label] of Object.entries({getBlockedContacts:'Listar contatos bloqueados',getContacts:'Listar contatos',getChats:'Listar conversas',getChannels:'Listar canais',getLabels:'Listar etiquetas',getBroadcasts:'Listar transmissões',getWWebVersion:'Versão do WhatsApp Web',getState:'Estado da conexão'})) method('account',id,label,'',true)
method('account','getBroadcastById','Consultar transmissão','broadcast',true)
method('account','getLabelById','Consultar etiqueta','label',true);method('account','getChatsByLabelId','Conversas com etiqueta','label',true)
define('account','searchMessages','Pesquisar mensagens','query limit',(c,p)=>c.searchMessages(p.query,{limit:p.limit}),true)
method('account','sendPresenceAvailable','Ficar disponível');method('account','sendPresenceUnavailable','Ficar indisponível')
for (const [id,label] of Object.entries({setAutoDownloadAudio:'Download automático de áudio',setAutoDownloadDocuments:'Download automático de documentos',setAutoDownloadPhotos:'Download automático de fotos',setAutoDownloadVideos:'Download automático de vídeos',setBackgroundSync:'Sincronização em segundo plano'})) method('account',id,label,'enabled')
method('account','isRegisteredUser','Verificar número no WhatsApp','number',true)
method('account','getNumberId','Consultar ID de telefone','number',true)
method('account','getContactLidAndPhone','Relacionar telefones e IDs','users',true)
method('account','getContactDeviceCount','Contar dispositivos do contato','user',true)
method('account','saveOrEditAddressbookContact','Salvar ou editar contato','number first last')
method('account','deleteAddressbookContact','Excluir contato da agenda','number')
define('account','createCallLink','Criar link de chamada','when callType',(c,p)=>c.createCallLink(new Date(p.when),p.callType))
define('account','createChannel','Criar canal','title description',(c,p)=>c.createChannel(p.title,{description:p.description}))
define('account','searchChannels','Pesquisar canais','query limit',(c,p)=>c.searchChannels({searchText:p.query,limit:p.limit}),true)
method('account','getChannelByInviteCode','Consultar canal por convite','code',true)
method('account','subscribeToChannel','Seguir canal','channel');method('account','unsubscribeFromChannel','Deixar de seguir canal','channel')
method('account','acceptChannelAdminInvite','Aceitar administração de canal','channel')
method('channel','getSubscribers','Consultar inscritos','limit',true)
method('channel','setSubject','Alterar nome do canal','title');method('channel','setDescription','Alterar descrição do canal','description')
define('channel','setProfilePicture','Alterar foto do canal','file',(ch,p)=>ch.setProfilePicture(media(p.file)))
method('channel','setReactionSetting','Alterar reações permitidas (0–2)','choice')
method('channel','mute','Silenciar canal');method('channel','unmute','Reativar notificações do canal');method('channel','sendSeen','Marcar canal como lido')
method('channel','sendChannelAdminInvite','Convidar administrador do canal','user');method('channel','revokeChannelAdminInvite','Revogar convite de administrador','user')
method('channel','demoteChannelAdmin','Remover administrador do canal','user');method('channel','transferChannelOwnership','Transferir propriedade do canal','user')
method('channel','deleteChannel','Excluir canal')
define('channel','history','Ler mensagens do canal','limit',(ch,p)=>ch.fetchMessages({limit:p.limit}),true)
define('channel','post','Publicar no canal','text',(_,p,c)=>send(c,p.text))
define('channel','media','Publicar mídia no canal','file description',(_,p,c)=>send(c,media(p.file),{caption:p.description}))

method('contact','getBroadcast','Consultar status do contato','',true)
define('account','postStatus','Publicar texto no status','text',(_,p,c)=>send({...c,chat:'status@broadcast'},p.text))
define('account','postStatusMedia','Publicar mídia no status','file description',(_,p,c)=>send({...c,chat:'status@broadcast'},media(p.file),{caption:p.description}))
method('account','revokeStatusMessage','Apagar publicação de status','statusMessage')
define('account','calls','Chamadas recebidas recentes','',(_,p,c)=>[...(c.calls?.values() || [])].map(call=>({id:call.id,from:call.from,video:call.isVideo})),true)
define('account','rejectCall','Recusar chamada recebida','call',(_,p,c)=>{
  const call=c.calls?.get(p.call)
  if (!call) fail('Chamada indisponível.')
  return call.reject()
})

// Unlike Message.delete(true), this does not fall through to local deletion if revocation is denied.
async function revokeEveryone(client, id) {
  return client.pupPage.evaluate(async id=>{
    const collection=window.require('WAWebCollections')
    const msg=collection.Msg.get(id) || (await collection.Msg.getMessagesById([id]))?.messages?.[0]
    const cap=window.require('WAWebMsgActionCapability')
    if (!msg || !(cap.canSenderRevokeMsg(msg)||cap.canAdminRevokeMsg(msg))) throw Error('O WhatsApp não permite mais apagar esta mensagem para todos.')
    const chat=collection.Chat.get(msg.id.remote)||await collection.Chat.find(msg.id.remote)
    const cmd=window.require('WAWebCmd').Cmd
    return window.WWebJS.compareWwebVersions(window.Debug.VERSION,'>=','2.3000.0')
      ? cmd.sendRevokeMsgs(chat,{list:[msg],type:'message'},{clearMedia:false})
      : cmd.sendRevokeMsgs(chat,[msg],{clearMedia:false,type:msg.id.fromMe?'Sender':'Admin'})
  },id)
}

function present(value, depth=0) {
  if (value == null) return null
  if (typeof value !== 'object') return value
  if (depth>5) return undefined
  if (Array.isArray(value)) return value.map(v=>present(v,depth+1))
  if (value.id && ![Object,Array].includes(value.constructor) && typeof value.id === 'object') {
    return {id:wid(value.id),name:value.name || value.pushname,title:value.title,body:value.hasMedia ? undefined : value.body?.slice(0,1000),
      type:value.type,role:value.role,reaction:value.reaction,sender:wid(value.senderId),timestamp:value.timestamp,
      totalCount:value.totalCount,unreadCount:value.unreadCount,description:value.description,options:value.pollOptions}
  }
  return Object.fromEntries(Object.entries(value).filter(([key])=>!['client','_data','data','mediaKey','messageSecret'].includes(key))
    .map(([key,v])=>[key,present(v,depth+1)]))
}
async function execute(id, params, ctx) {
  const action=actions.get(id)
  const p=validate(id,params)
  const {client,chat,message}=ctx
  let target=client
  if (action.scope === 'message') {
    target=await client.getMessageById(message)
    if (!target || (target.fromMe?target.to:target.from)!==chat) fail('Mensagem indisponível nesta conversa.')
  } else if (action.scope === 'contact') {
    const [contact, extra]=ids(ctx.contact || chat,'users')
    if (extra) fail('Selecione um único contato.')
    if (!contact) fail('Escolha um contato.')
    target=await client.getContactById(contact)
  } else if (action.scope !== 'account') {
    if (!chat) fail('Escolha uma conversa.')
    target=await client.getChatById(chat)
    if (!target || (action.scope==='group' && !target.isGroup) || (action.scope==='channel' && !target.isChannel)) fail('O destino não corresponde à ação selecionada.')
  }
  if (id==='channel.setReactionSetting' && p.choice>2) fail('Opções de reações do canal: 0, 1 ou 2.')
  const result=await action.apply(target,p,ctx)
  if (['group.addParticipants','account.createGroup','account.createChannel'].includes(id) && typeof result==='string') fail(result)
  if (id==='group.addParticipants' && Object.values(result || {}).some(item=>item.code !== 200)) {
    const statuses=Object.entries(result || {}).map(([number,item])=>number + ' · ' + item.code + ' ' + (item.message || ''))
    fail('Resultado por participante: ' + statuses.join(' / '))
  }
  if (['message.edit','message.editEvent'].includes(id) && !result) fail('O WhatsApp não permitiu editar a mensagem.')
  if (result===false && !action.read && !['chat.unpin','chat.unarchive'].includes(id)) fail('O WhatsApp não aceitou a operação.')
  if (id==='message.media') return result
  return present(result)
}
const catalog = [...actions.values()].map(({apply,...description})=>description)
module.exports={catalog,fieldTypes,execute,validate,revokeEveryone}
