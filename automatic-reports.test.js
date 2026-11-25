const test = require('node:test')
const assert = require('node:assert/strict')
const reports = require('./automatic-reports')
const board = require('./today-categories')
const classifier = require('./today-classifier')
const {captureEvents} = require('./intelligence')

const prompt = 'Agrupe mensagens automaticas do tipo "Envio de relatorio..." ou "Envio relatório" ou qualquer mensagem que pareça automatica, as do grupo "avihub" sao automaticas também'
const body = '*Peso Exato*\r\n\r\n*[Relatório balança]*\nURL: PDF: https://example.invalid/a.pdf\nCSV_AVES: https://example.invalid/a.csv\nEnvio: WPP: SUCESSO PDF + CSV_AVES'
const account = {id:'teste',name:'Conta de teste',mode:'local'}
const category = {id:'custom',name:'Avisos dos equipamentos',hidden:true,days:0,prompt,since:5}
const msg = (id,extra={})=>({id,chat:'equipe@g.us',account:account.id,body,timestamp:10,liveReceivedAt:10,status:'done',...extra})
const event = (m,extra={})=>({id:'ev'+m.id,account:m.account,chat:m.chat,source:m.id,topic:'envio do relatório balança',status:'concluido',detail:'PDF enviado',quote:'SUCESSO PDF + CSV_AVES',...extra})
function fixture(messages) {
  return {accounts:[account],messages,todayCategories:[category],todayLessons:[],revokedMessages:[],intelligence:{events:[]},todayCardPlaces:{}}
}

test('o prompt efetivo classifica o comprovante mesmo se o modelo não retornar a lista',()=>{
  const m=msg('a')
  const state=fixture([m])
  const packet=classifier.prepare(state,m,account,classifier.availableLists(state,m),{tipo:'grupo',nome:'Equipe'},()=> 'Participante')
  const result=classifier.decide(state,m,packet,{matches:[]})
  assert.deepEqual(result.ids,['custom'])
  assert(m.body.includes(result.evidence.custom.quote))
  state.revokedMessages=[m]
  assert.deepEqual(classifier.decide(state,m,packet,{matches:[]}).ids,[])
})
test('respeita nome do grupo, intenção da regra e formato do aviso',()=>{
  assert.equal(reports.ruleMatch(prompt,null,'AviHub').source,'conversa')
  assert.equal(reports.ruleMatch(prompt,null,'AviHub Clientes'),undefined)
  assert.equal(reports.ruleMatch('Não agrupe mensagens automáticas', 'Relatório balança'),undefined)
  assert.equal(reports.ruleMatch('Somente mensagens automáticas do grupo "Clientes"', 'Relatório balança'),undefined)
  assert.equal(reports.reportEvidence(msg('b',{body:'Consegue enviar o relatório de balança em PDF e CSV?'})),undefined)
})
test('recupera relatórios antigos uma vez e preserva cartões movidos, removidos e revogados',()=>{
  const [a,b,c,d,e]=['a','b','c','d','e'].map(id=>msg(id,{liveReceivedAt:1}))
  const state=fixture([a,b,c,d,e])
  state.intelligence.events=[event(a),event(b),event(c)]
  state.todayCardPlaces[board.cardKey('decision',event(b))]='manual'
  state.todayCardPlaces[board.cardKey('decision',event(c))]=null
  state.revokedMessages=[d]
  state.todayCardPlaces[board.cardKey('message',e)]={added:{},removed:['custom']}
  assert.equal(reports.repairExisting(state),1)
  assert.equal(reports.repairExisting(state),0)
  const represented=new Map()
  const cards=board.nativeCards(state,'decision',state.intelligence.events,'today-decisions',10,board.cardRoutes(state),represented)
  assert.deepEqual(cards.map(c=>c.card.category),['custom','manual'])
  assert.equal(represented.get(board.cardKey('decision',event(a))).messageKey,board.cardKey('message',a))
  assert.equal(state.intelligence.events.length,3)
})
test('a decisão respeita o destino explícito da mensagem e seu movimento manual',()=>{
  const m=msg('a',{todayCategoryIds:['custom']})
  const state=fixture([m])
  state.todayCardPlaces[board.cardKey('message',m)]={removed:['custom'],added:{'nova-lista':100}}
  const [card]=board.nativeCards(state,'decision',[event(m)],'today-decisions',10,board.cardRoutes(state))
  assert.equal(card.card.category,'nova-lista')
})
test('recibo automático não cria compromisso de envio e mantém decisões humanas',()=>{
  const m=msg('a')
  const data={events:[]}
  assert.equal(captureEvents(data,[m],[event(m)]),0)
  const human=msg('b',{body:'Aprovamos enviar o relatório na sexta.'})
  assert.equal(captureEvents(data,[human],[event(human,{quote:human.body})]),1)
})
