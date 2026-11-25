const test = require('node:test')
const assert = require('node:assert/strict')
const {prepare,availableLists,decide} = require('./today-classifier')
const {buildExamples} = require('./today-learning')
const {cardKey} = require('./today-categories')

const acct = {id:'trabalho',name:'Empresa',mode:'cloud'}
const conversation = {nome:'Operações',tipo:'grupo'}
const start = Date.UTC(2026,10,24,12)
const row = (id,body,extra={}) => ({account:acct.id,chat:'grupo',id,body,timestamp:start,liveReceivedAt:start,...extra})
function fixture() {
  const quoted = row('false_grupo_REF_1@lid','Reservar duas diárias no hotel?',{timestamp:start-86400000,status:'archived'})
  const near = row('bola','A quadra está livre hoje?',{timestamp:start-1000})
  const current = row('alvo','Pode confirmar as duas.',{quotedStanza:'REF',repliesToMessage:true})
  const state = {messages:[quoted,near,current],todayLessons:[],revokedMessages:[],todayCategories:[
    {id:'hotel',name:'Hospedagem',prompt:'Reservas de hotel',since:0},
    {id:'jogo',name:'Futebol',prompt:'Eventos esportivos',since:0}]}
  return {state,current}
}
const makePacket = (state,current) => prepare(state,current,acct,availableLists(state,current),conversation,
  m=>m.fromMe?'Você':'Participante')
const positive = {lista:1,atual:'confirmar as duas',fonte:'citada',apoio:'duas diárias',motivo:'A resposta confirma a reserva solicitada.'}

test('separa a resposta citada da conversa paralela e respeita conta, chat, tempo, privacidade e revogação',()=>{
  const {state,current}=fixture()
  state.messages.push(row('future','futuro',{timestamp:start+1}),row('another','fora',{chat:'outro'}),
    row('p','local',{queuedMode:'local',timestamp:start-3}), row('f','fora',{account:'pessoal'}),
    row('sameTime','posterior'),row('rev','apagada',{timestamp:start-100}),row('ignored','ignorada',{status:'ignored',timestamp:start-1}))
  state.revokedMessages.push({id:'old',aliases:['rev'],chat:'grupo',account:acct.id})
  const packet=makePacket(state,current)
  assert.equal(packet.payload.citacao.texto,'Reservar duas diárias no hotel?')
  assert.deepEqual(packet.payload.anteriores.map(r=>r.texto),['A quadra está livre hoje?'])
  assert.deepEqual(decide(state,current,packet,{matches:[positive]}).ids,['hotel'])
  state.revokedMessages.push({id:packet.sourceIds.citada,account:acct.id,chat:'grupo'})
  assert.deepEqual(decide(state,current,packet,{matches:[positive]}).ids,[])
})

test('rejeita categoria inventada, trecho fabricado, origem sem regra e critério modificado durante a análise',()=>{
  const {state,current}=fixture()
  const packet=makePacket(state,current)
  for (const change of [{lista:3},{atual:'Pague imediatamente'},{fonte:'outra'},{apoio:'diárias triplas'},
    {fonte:'conversa',apoio:'Operações'}]) {
    assert.deepEqual(decide(state,current,packet,{matches:[{...positive,...change}]}).ids,[])
  }
  state.todayCategories[0].prompt='Somente cancelamentos'
  assert.deepEqual(decide(state,current,packet,{matches:[positive]}).ids,[])
})

test('aceita aprendizado por intenção mesmo sem palavras iguais; reavaliação respeita revisão e correções',()=>{
  const {state,current}=fixture()
  const example=row('ex','Agendamento de capacitação dos operadores',{timestamp:start-10000})
  state.messages.push(example)
  state.todayCategories.push({id:'curso',name:'Cursos',prompt:'',since:0})
  state.todayLessons=buildExamples(state,[{key:cardKey('message',example),destination:'curso'}],start-1000).lessons
  const packet=makePacket(state,current)
  const match={lista:3,atual:'confirmar',fonte:'atual',apoio:'confirmar',motivo:'teste',exemplo:1}
  assert.deepEqual(decide(state,current,packet,{matches:[{...match,exemplo:99}]}).ids,[])
  assert.equal(decide(state,current,packet,{matches:[match]}).learned.destination,'curso')
  state.todayLessons=[]
  assert.deepEqual(decide(state,current,packet,{matches:[match]}).ids,[])
  state.todayCategories[0].since=start+100
  assert(!availableLists(state,current).some(c=>c.id==='hotel'))
  assert(availableLists(state,current,start+150).some(c=>c.id==='hotel'))
})

test('preserva o conteúdo de áudio e documento com limites de contexto',()=>{
  const {state,current}=fixture()
  current.transcript='Confirmo a reserva do quarto.'
  state.messages.unshift(row('pdf','',{timestamp:start-50,extracted:'Comprovante da pousada'}))
  const packet=makePacket(state,current)
  assert.match(packet.sources.atual,/reserva do quarto/)
  assert(packet.payload.anteriores.some(m=>m.texto.includes('Comprovante da pousada')))
})

const {messageAuthor,senderNamesForRule} = require('./message-authors')

function route(prompt, options = {}) {
  const account = {...acct,chatNames:{'10@c.us':'Ana Souza','20@c.us':'Bruno','100@g.us':'Expedição'}}
  const tipo = options.direct ? 'individual' : 'grupo'
  const chat = options.direct ? '10@c.us' : '100@g.us'
  const current = row('alvo','Ana Souza falou sobre pagamentos no grupo Expedição.',{
    chat,sender:'10@lid',...options.message})
  const state = {messages:[current],people:{'10@c.us':{profile:{name:'Ana do Financeiro'}}},
    personAliases:{'trabalho/10@lid':'10@c.us'},senderNames:{trabalho:{}},todayLessons:[],
    todayCategories:[{id:'destino',name:'Lista',prompt,since:0}]}
  const author = messageAuthor(state,account,chat,current)
  const names = senderNamesForRule(state,account,chat,current,author)
  const packet = prepare(state,current,account,availableLists(state,current),
    {tipo,nome:options.title || account.chatNames[chat]},()=>author.senderName,names)
  if (options.revoke) state.revokedMessages=[{account:account.id,chat,id:current.id}]
  if (options.edit) state.todayCategories[0].prompt = options.edit
  const matches = options.model ? [{lista:1,fonte:'atual',atual:'pagamentos',apoio:'pagamentos',motivo:'Trata de pagamentos.',...options.model}] : []
  return {packet,decision:decide(state,current,packet,{matches})}
}

test('regras de remetente usam o participante e seus nomes verificados na conta',()=>{
  for (const direct of [true,false]) {
    const {packet,decision} = route('Mensagens da Ana Souza',{direct})
    assert.deepEqual(decision.ids,['destino'])
    assert.equal(decision.evidence.destino.quote,'Ana Souza')
    assert.deepEqual(packet.payload.atual.origem.nomesDoRemetente,['Ana do Financeiro','Ana Souza'])
    assert.deepEqual(route('Mensagens da Ana Souza',{direct,message:{fromMe:true},model:{}}).decision.ids,[])
  }
  assert.deepEqual(route('Mensagens de Ana Souza',{message:{sender:'20@c.us'},model:{}}).decision.ids,[])
  assert.deepEqual(route('Mensagens recebidas de Ana Souza',{message:{sender:'20@c.us'},model:{}}).decision.ids,[])
  assert.deepEqual(route('Mensagens da Ana Souza',{message:{sender:undefined,senderHint:'Ana Souza'},model:{}}).decision.ids,[])
  assert.deepEqual(route('Mensagens de “Ana do Financeiro”',{message:{body:'',type:'image'}}).decision.ids,['destino'])
})

test('origem do grupo vale para qualquer participante e não para um contato com o mesmo nome',()=>{
  const prompt='Agrupe todas as mensagens do grupo EXPEDICAO.'
  assert.deepEqual(route(prompt,{message:{sender:'20@c.us',body:''}}).decision.ids,['destino'])
  assert.deepEqual(route(prompt,{message:{fromMe:true}}).decision.ids,['destino'])
  assert.deepEqual(route(prompt,{direct:true,title:'Expedição',model:{}}).decision.ids,[])
  assert.deepEqual(route(prompt,{title:'Comercial',model:{}}).decision.ids,[])
  assert.deepEqual(route(prompt,{edit:'Somente orçamentos'}).decision.ids,[])
  assert.deepEqual(route(prompt,{revoke:true}).decision.ids,[])
})

test('condições de remetente, grupo e assunto são cumulativas',()=>{
  const origin='Mensagens da Ana Souza no grupo Expedição'
  assert.deepEqual(route(origin).decision.ids,['destino'])
  assert.deepEqual(route(origin,{message:{sender:'20@c.us'},model:{}}).decision.ids,[])
  const prompt=origin+' sobre pagamentos'
  assert.deepEqual(route(prompt).decision.ids,[])
  assert.deepEqual(route(prompt,{model:{}}).decision.ids,['destino'])
  assert.deepEqual(route(prompt,{model:{fonte:'autor',apoio:'Ana Souza'}}).decision.ids,[])
  assert.deepEqual(route(prompt,{title:'Oficina',model:{}}).decision.ids,[])
  assert.deepEqual(route('Mensagens de pagamentos',{model:{}}).decision.ids,['destino'])
  const alternative = 'Mensagens da Ana Souza sobre pagamentos ou mensagens do grupo Expedição'
  assert.deepEqual(route(alternative,{message:{sender:'20@c.us'},model:{}}).decision.ids,['destino'])
  assert.deepEqual(route('Mensagens do grupo Expedição exceto sobre pagamentos').decision.ids,[])
})
