const test = require('node:test')
const assert = require('node:assert/strict')
const { buildExamples, applyLearning, changesFromPlaces } = require('./today-learning')
const { cardKey, nativeCards, groupedMessages } = require('./today-categories')
const message = (id,body,overrides = {}) => ({id,account:'p',chat:'loja',body,liveReceivedAt:200,timestamp:200,...overrides})
function teach(state, record, destination, kind = 'message', at = 100) {
  state.todayLessons = buildExamples(state,[{key:cardKey(kind,record),destination}],at).lessons
}

test('a última correção acompanha a mensagem e sobrevive ao reinício', () => {
  const first = message('1','Segue boleto de aluguel da loja 145')
  const state = {messages:[first]}
  teach(state,first,'contas')
  teach(state,first,'aluguel')
  const next = message('2','Boletos de aluguel da loja 847')
  applyLearning(JSON.parse(JSON.stringify(state)),next)
  assert.equal(next.todayLearned.destination,'aluguel')
  state.messages.push(next)
  teach(state,next,'financeiro','message',210)
  const third = message('3','Boleto de aluguel da loja 345',{liveReceivedAt:300})
  applyLearning(state,third)
  assert.equal(third.todayLearned.destination,'financeiro')
  assert.equal(state.todayLessons.length,1)
})

test('isola contas, ignora histórico, saudações e conflitos entre destinos', () => {
  const a = message('1','Orçamento motor galpão norte')
  const b = message('2','Orçamento motor galpão sul')
  const state = {messages:[a,b]}
  teach(state,a,'norte')
  teach(state,b,'sul')
  for (const row of [message('3','Orçamento motor galpão'),message('4',a.body,{account:'trabalho'}),
    message('5',a.body,{liveReceivedAt:90}),message('6',a.body,{liveReceivedAt:undefined}),message('7','Bom dia')]) {
    applyLearning(state,row)
    assert.equal(row.todayLearned,undefined)
  }
})

test('aprende com o texto extraído e encaminha o cartão nativo com suas ações', () => {
  const first = message('1','',{transcript:'Troca correia do ventilador'})
  const state = {messages:[first],revokedMessages:[],todayCategories:[{id:'manutencao',days:0}]}
  teach(state,first,'manutencao','unanswered')
  const next = message('2','')
  applyLearning(state,next)
  assert.equal(next.todayLearned,undefined)
  next.transcript='Troca de correias do ventilador'
  applyLearning(state,next)
  state.messages.push(next)
  const source=JSON.stringify([next.account,next.id])
  const cards=nativeCards(state,'unanswered',[next],'today-unanswered',30,new Map([[source,next.todayLearned]]))
  assert.equal(cards[0].card.category,'manutencao')
  assert.equal(groupedMessages(state,'2026-11-24',()=> '2026-11-24').get('manutencao').messages[0].id,'2')
})

test('recupera o último destino salvo e exclui exclusões ou destinos ambíguos', () => {
  assert.deepEqual(changesFromPlaces({a:null,b:'compras',c:{added:{um:1,dois:2}},d:{added:{um:2,dois:2}}}),
    [{key:'b',destination:'compras'},{key:'c',destination:'dois'}])
})

test('análise semântica aceita só exemplos enviados, da mesma conta e ainda válidos', () => {
  const {semanticExamples, applySemantic} = require('./today-learning')
  const first = message('1','Trocar a correia do exaustor')
  const next = message('2','Substituir a cinta da ventilação')
  const state = {messages:[first]}
  teach(state,first,'manutencao')
  const examples = semanticExamples(state,next)
  assert.equal(examples.length,1)
  assert.deepEqual(semanticExamples(state,{...next,account:'outra'}),[])
  for (const result of [{todayExample:0,todayExampleConfidence:'alta'}, {todayExample:1,todayExampleConfidence:'baixa'}]) {
    applySemantic(state,next,examples,result)
    assert.equal(next.todayLearned,undefined)
  }
  const answer = {todayExample:1,todayExampleConfidence:'alta'}
  applySemantic(state,next,examples,answer)
  assert.equal(next.todayLearned.destination,'manutencao')
  teach(state,first,'ventilacao')
  const concurrent = message('3',next.body)
  applySemantic(state,concurrent,examples,answer)
  assert.equal(concurrent.todayLearned,undefined)
})
