const test = require('node:test')
const assert = require('node:assert/strict')
const {messageSender,messageAuthor,readAuthorContacts,contactKey} = require('./message-authors')

const people = { '5511@c.us':{profile:{name:'Ana'}} }
const state = {people,personAliases:{'p/123@lid':'5511@c.us'},senderNames:{w:{'123@lid':'Bruno'}}}
const personal = {id:'p',chatNames:{'123@lid':'Nome da agenda','42@g.us':'Família'}}
const work = {id:'w'}
const group = '42@g.us'

test('separa grupos, contas, autores e mensagens próprias',()=>{
  assert.equal(contactKey('p','123:4@lid'),'p/123@lid')
  assert.deepEqual(messageAuthor(state,personal,group,{sender:'123@lid'}),{personId:'5511@c.us',senderName:'Ana'})
  assert.deepEqual(messageAuthor(state,work,group,{sender:'123@lid'}),{personId:'w/123@lid',senderName:'Bruno'})
  assert.deepEqual(messageAuthor(state,work,group,{fromMe:true,sender:'123@lid'}),{personId:null,senderName:'Você'})
  assert.deepEqual(messageAuthor(state,personal,group,{sender:group}),{personId:null,senderName:'Participante sem nome'})
  assert.deepEqual(messageAuthor(state,personal,group,{type:'gp2',sender:'123@lid'}),{personId:null,senderName:'WhatsApp'})
})

test('recupera participante somente da chave do grupo correto e usa o remetente de conversa individual',()=>{
  assert.equal(messageSender({from:group,id:{participant:{$1:'123:3@lid'}}}),'123@lid')
  assert.equal(messageSender({sender:group,id:'false_42@g.us_HEX_123@lid'},group),'123@lid')
  assert.equal(messageSender({sender:group,id:'false_99@g.us_HEX_123@lid'},group),null)
  assert.equal(messageSender({sender:group,id:'true_42@g.us_HEX_123@lid'},group),null)
  assert.equal(messageSender({from:'5511@c.us',author:'888@lid'}),'5511@c.us')
  assert.deepEqual(messageAuthor(state,personal,'123@lid',{sender:'5511@s.whatsapp.net'}),{personId:'5511@c.us',senderName:'Ana'})
  assert.equal(messageAuthor(state,personal,'123@lid',{sender:'5599@c.us'}).senderName,'+5599')
})

test('nomes iguais e recados de remetente não criam vínculos entre pessoas',()=>{
  const one = messageAuthor(state,work,group,{sender:'456@lid',senderHint:'Ana'})
  const two = messageAuthor(state,work,group,{sender:'789@lid',senderHint:'Ana'})
  assert.equal(one.senderName,two.senderName)
  assert.notEqual(one.personId,two.personId)
  assert.equal(messageAuthor(state,work,group,{sender:'789@lid',senderHint:'789@lid'}).senderName,'Participante sem nome')
})

test('consulta os contatos pelo ID da conta no modelo do WhatsApp',async()=>{
  const wid = id => ({_serialized:id,server:id.split('@')[1]})
  const items = new Map([['5511@c.us',{name:'Nome da agenda',pushname:'Apelido'}]])
  const services = {WAWebCollections:{Contact:{get:id=>items.get(id._serialized),find:async()=>null}},
    WAWebWidFactory:{createWid:wid},WAWebApiContact:{getAlternateUserWid:id=>id.server==='lid'?wid('5511@c.us'):null},
    WAWebContactGetters:{getName:c=>c.name,getPushname:c=>c.pushname}}
  global.window = {require:name=>services[name]}
  try {
    const [contact] = await readAuthorContacts(['123@lid'])
    assert.equal(contact.id,'123@lid')
    assert.equal(contact.pn,'5511@c.us')
    assert.equal(contact.name,'Nome da agenda')
  } finally { delete global.window }
})
