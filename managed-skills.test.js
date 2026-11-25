const test=require('node:test')
const assert=require('node:assert/strict')
const {evaluate}=require('./managed-evaluator')
const {eventFor,eligible,applyEffects}=require('./managed-messages')
const rule={id:'regra',name:'Nome privado',action:'task',instruction:'Instrução privada da gestão',group:'Expedição',active:true,revision:1,since:100}
const record={id:'m1',account:'trabalho',chat:'grupo@g.us',status:'done',body:'Pedido 123 atrasou.',timestamp:200,liveReceivedAt:200}
const account={id:'trabalho',name:'Trabalho',mode:'local'}
function state(text){return {actions:[],aiQueries:[],revokedMessages:[],messages:[{...record,body:text}]}}
const event=(s,title='Expedição')=>eventFor(s,s.messages.at(-1),account,title,()=> 'Ana')

test('mesmo grupo e IDs em usuários diferentes geram resultados locais e idempotentes',async()=>{
  for(const [tenant,text] of [['pessoal','Pedido 123 atrasou.'],['outro','O lote 45 mudou.']]){
    const s=state(text),e=event(s)
    const result=await evaluate(e,()=>[rule],async(prompt,data,privateRule)=>{
      if(privateRule){
        assert.equal(data.instruction,rule.instruction)
        assert.deepEqual(data.current,[text]);return {match:true,quotes:[text,rule.instruction]}
      }
      assert.deepEqual(data,{evidencias:[text]})
      assert(!prompt.includes(rule.instruction))
      return {text}
    },tenant)
    assert.equal(result.next,null)
    assert.deepEqual(Object.keys(result.effects[0]).sort(),['action','id','text'])
    applyEffects(s,record,account,e.title,result.effects);applyEffects(s,record,account,e.title,result.effects)
    assert.equal(s.actions.length,1);assert.equal(s.actions[0].title,text)
    assert(!JSON.stringify(s).includes(rule.instruction))
  }
})
test('uma menção ao grupo, uma conversa individual e mensagens anteriores à ativação não disparam',async()=>{
  const e=event(state('Mencionaram Expedição.'))
  for(const mod of [{title:'Outro'},{chat:'10@c.us'},{receivedAt:99}]){
    assert.deepEqual(await evaluate({...e,...mod},()=>[rule],()=>assert.fail(),'uid'),{effects:[],next:null})
  }
  assert.deepEqual(await evaluate(e,()=>[{...rule,active:false}],()=>assert.fail(),'uid'),{effects:[],next:null})
  let enabled=true
  const result=await evaluate(e,()=>[{...rule,active:enabled}],async()=>{enabled=false;return {match:true,quotes:[e.text],text:'Tarefa'}},'uid')
  assert.deepEqual(result.effects,[])
})
test('seleção de contexto respeita remetente, conta, grupo, exclusões e modo local',()=>{
  const s=state('atual'),current=s.messages[0]
  s.revokedMessages.push({account:account.id,chat:record.chat,id:'apagada'})
  s.messages.unshift(...[
    {id:'boa',body:'anterior'}, {id:'apagada',body:'x'}, {id:'outra',account:'pessoal'},{id:'grupo2',chat:'outro@g.us'},
    {id:'reservada',queuedMode:'local'},{id:'ignorada',status:'ignored'}].map(extra=>({...record,...extra,timestamp:100})))
  assert.deepEqual(eventFor(s,current,{...account,mode:'cloud'},'Expedição',()=> 'Ana').history,[{sender:'Ana',text:'anterior'}])
  assert(!eligible({...record,fromMe:true},account,s))
  assert(!eligible({...record,queuedMode:'local'},{...account,mode:'cloud'},s))
})
test('várias regras são executadas por página, com resumo e rascunho vinculados à origem',async()=>{
  const s=state('Texto do grupo'),e=event(s)
  const rules=['summary','draft'].map(action=>({...rule,id:action,action,instruction:''}))
  const run=cursor=>evaluate({...e,cursor},()=>rules,async(prompt,data,privateRule)=>{
    assert(!privateRule);assert.deepEqual(data.evidencias,[e.text]);return {text:'Resultado'}
  },'uid')
  const first=await run()
  assert(first.next);const second=await run(first.next);assert.equal(second.next,null)
  applyEffects(s,record,account,e.title,[...first.effects,...second.effects])
  assert.equal(s.aiQueries.length,2)
  const draft=s.aiQueries.find(q=>q.delivery)?.delivery
  assert.deepEqual([draft.status,draft.account,draft.chat,draft.quoted],['draft',account.id,record.chat,record.id])
  assert(s.aiQueries.every(q=>q.thread===s.aiQueries[0].thread))
})
