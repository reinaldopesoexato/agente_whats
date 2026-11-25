const test = require('node:test')
const assert = require('node:assert/strict')
const {publishedDecisionEvents,nativeCards,cardKey} = require('./today-categories')
const {sourceKey} = require('./today-learning')
const {latestEvents} = require('./intelligence')
const origin = 'today-decisions'
function fixture() {
  const old = {account:'p',id:'old',key:'topic',source:'previous',timestamp:1,status:'confirmado'}
  const next = {...old,id:'event',source:'msg',timestamp:2,status:'alterado'}
  return {messages:[{account:'p',id:'msg',todayReview:{status:'pending',newDecisionIds:['event']}}],
    intelligence:{events:[old,next,{...next,account:'w',key:'different'}]}}
}
function cards(state,account,routes) {
  const events = publishedDecisionEvents(state,account)
  return nativeCards(state,'decision',latestEvents({events}),origin,25,routes)
}

test('decisão nova aguarda a primeira classificação e estreia no destino aprendido',()=>{
  const state=fixture()
  assert.deepEqual(cards(state,'p').map(c=>c.id),['old'])
  assert.equal(cards(state,'w')[0].id,'event')
  assert.equal(cards(state,undefined).length,2)
  const saved=JSON.parse(JSON.stringify(state))
  assert.deepEqual(publishedDecisionEvents(saved,'p').map(c=>c.id),['old'])
  delete saved.messages[0].todayReview
  const routes=new Map([[sourceKey('p','msg'),{kind:'decision',destination:'hotel'}]])
  const result=cards(saved,'p',routes)
  assert.deepEqual(result.map(c=>[c.id,c.card.category]),[['event','hotel']])
})
test('publica na origem sem redirecionamento ou após falha final; revisão de cartão publicado mantém a lista',()=>{
  const state=fixture()
  for (const review of [undefined,{status:'error',newDecisionIds:['event']},{status:'pending',requestedAt:100}]) {
    state.messages[0].todayReview=review
    assert.deepEqual(cards(state,'p').map(c=>[c.id,c.card.category]),[['event',origin]])
  }
})
test('preserva a posição escolhida pelo usuário',()=>{
  const state=fixture()
  const event=state.intelligence.events[1]
  state.todayCardPlaces={[cardKey('decision',event)]:'manual'}
  assert.equal(cards(state,'p')[0].card.category,'manual')
})
