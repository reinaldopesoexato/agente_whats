const test = require('node:test')
const assert = require('node:assert/strict')
const s = require('./today-supplements')

const message = (id,body,fields={}) => ({account:'work',chat:'group',id,body,timestamp:1,liveReceivedAt:1,status:'done',...fields})
const card = m => JSON.stringify(['message',m.account,m.id])
function items(state,record,roots,cited) {
  const idx = s.index(state,record.account,record.chat,'cloud')
  return s.candidates(idx,record,cited,visit=>roots.forEach(m=>visit(m,'reservas',card(m))),m=>m.sender)
}
function link(record,list,old,fresh,summary) {
  return s.proposal(record,list,{complemento:{item:1,anterior:old,novo:fresh,resumo:summary}})?.change
}

test('correções entre participantes continuam no mesmo cartão mesmo após recarregar os dados',()=>{
  const root=message('a','Reserva L42 para duas pessoas às 15h')
  const second=message('b','Corrigindo para 16h',{sender:'outra pessoa'})
  const third=message('c','Na verdade somos três',{fromMe:true})
  let state={messages:[root,second,third]}
  second.todaySupplement=link(second,items(state,second,[root]),'L42','16h','Reserva L42 para duas pessoas às 16h')
  const candidates=items(state,third,[root],'b')
  assert.equal(candidates[0].previous,'b')
  third.todaySupplement=link(third,candidates,'16h','três','Reserva L42 para três pessoas às 16h')
  state=JSON.parse(JSON.stringify(state))
  const view=s.presentation(s.index(state),card(root))
  assert.equal(view.summary,'Reserva L42 para três pessoas às 16h')
  assert.deepEqual(view.history.map(m=>m.source),['b','c'])
  state.revokedMessages=[{...second,id:'deleted',aliases:['b']}]
  assert.equal(s.presentation(s.index(state),card(root)).summary,'três')
  state.revokedMessages.push(root)
  assert.equal(s.presentation(s.index(state),card(root)),undefined)
})

test('limita candidatos por conta, conversa, horário, citação e privacidade',()=>{
  const root=message('a','Reunião Alpha')
  const elsewhere=message('a','Segredo',{chat:'outra'})
  const personal=message('a','Pessoal',{account:'home'})
  const local=message('b','Privado',{queuedMode:'local'})
  const other=message('c','Reunião Beta')
  const current=message('atual','Às 17h')
  const future=message('depois','Reunião Gamma')
  const roots=[root,elsewhere,personal,local,other,future]
  const state={messages:[root,elsewhere,personal,local,other,current,future]}
  assert.deepEqual(items(state,current,roots,'a').map(i=>i.base),['Reunião Alpha'])
  assert.equal(items(state,current,roots,'desconhecida').length,0)
  assert.equal(items(state,current,roots).length,2)
})

test('exige evidência nas duas mensagens e descarta agradecimentos ou índice inválido',()=>{
  const root=message('a','Reserva Alpha')
  const m=message('b','Chego às 16h')
  const list=items({messages:[root,m]},m,[root])
  assert.equal(link(m,list,'outro hotel','16h','Alterado'),undefined)
  assert.equal(link(m,list,'Alpha','17h','Alterado'),undefined)
  assert.equal(link(m,[],'Alpha','16h','Alterado'),undefined)
  assert.equal(link({...m,body:'Obrigado!'},list,'Alpha','Obrigado','Alterado'),undefined)
})

test('reconcilia mensagens já processadas sem repetir outras conversas e preserva ordem durante falhas',()=>{
  const root=message('a','Reserva')
  const before=message('z','oi')
  const other=message('c','independente',{chat:'outro',todayReview:{status:'pending'}})
  const second=message('b','às 14h')
  const third=message('d','quinta')
  const state={messages:[before,root,second,third,other]}
  s.queueLater(state,root)
  assert.equal(before.todayReview,undefined)
  assert(second.todayReview.reconcile && third.todayReview.reconcile)
  second.todayReview.retryAt=5
  assert.equal(s.nextReview(state.messages,{id:'work'},2),other)
  assert.equal(s.nextReview(state.messages,{id:'work'},6),second)
})

test('uma nova versão da decisão conserva o cartão de origem, a lista e a sequência de complementos',()=>{
  const {nativeCards}=require('./today-categories')
  const root=message('a','Contrato Alvorada previsto para quinta')
  const b=message('b','Contrato adiado para sexta')
  const c=message('c','Assinamos às 15h')
  const state={messages:[root,b,c]}
  const event={id:'v1',key:'contrato',account:'work',chat:'group',topic:'Contrato Alvorada',source:'a'}
  const key=e=>JSON.stringify(['decision',e.account,e.id])
  const find=(m,e)=>s.candidates(s.index(state,'work','group'),m,null,visit=>visit(e,'contratos',key(e)),()=> 'Equipe')
  b.todaySupplement={...link(b,find(b,event),'Alvorada','adiado','Contrato Alvorada adiado para sexta'),category:'contratos'}
  const next={...event,id:'v2',source:'b'}
  const routes=new Map([[JSON.stringify(['work','b']),{supplement:b.todaySupplement}]])
  assert.equal(nativeCards(state,'decision',[next],'today-decisions',3,routes)[0].card.category,'contratos')
  const candidates=find(c,next)
  assert.equal(candidates[0].root,'a')
  assert.equal(candidates[0].previous,'b')
  assert.equal(candidates[0].last,'Contrato Alvorada adiado para sexta')
})
