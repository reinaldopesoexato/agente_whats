const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('node:vm')
const readChatDirectory = require('./chat-directory')

// Exercise the same serialized expression sent to the WhatsApp page by Puppeteer.
function preview(body,extra = {}) {
  const collections = {
    Chat:{getModelsArray:()=>[{id:'123@g.us',lastReceivedKey:{_serialized:'m'}}]},
    Msg:{get:()=>({body,type:'chat',id:{fromMe:true},...extra})}
  }
  const [row] = vm.runInNewContext(readChatDirectory,{window:{require:()=>collections}})
  return JSON.parse(JSON.stringify(row.preview))
}

test('preserva os estilos que fecham além do limite e limita o texto visível',()=>{
  const text = 'a'.repeat(3000)
  for (const [open,close,tags] of [['*','*',['strong']],['_','_',['em']],['~','~',['s']],['`','`',['code']],
    ['```','```',['code']],['*_','_*',['strong','em']]]) {
    const p = preview('Antes '+open+text+close+' resto')
    assert.equal(p.text,'Antes '+'a'.repeat(134))
    assert.deepEqual(p.styles,[{from:6,to:140,tags}])
    assert.equal(p.fromMe,true)
  }
})
test('usa o fechamento real e preserva marcadores literais',()=>{
  const raw = '*'+'a'.repeat(200)
  for (const input of [raw,raw+' *',raw+'*abc',raw+'\noutro*']) {
    const p = preview(input)
    assert.equal(p.text,raw.slice(0,140))
    assert.deepEqual(p.styles,[])
  }
  const literal = '*'+'a'.repeat(138)+'*abc'
  assert.equal(preview(literal).text,literal.slice(0,140))
  assert.deepEqual(preview(literal).styles,[])
})
test('trata emoji no corte, listas, citações, mídia e textos curtos',()=>{
  const p = preview('> *'+'a'.repeat(139)+'🐥resto*')
  assert.equal([...p.text].length,140)
  assert(p.text.endsWith('🐥'))
  assert.deepEqual(p.styles,[{from:0,to:141,tags:['quote','strong']}])
  assert.equal(preview('- *'+'a'.repeat(200)+'*').text,'• '+'a'.repeat(138))
  assert.equal(preview('x'.repeat(500),{type:'image',directPath:'local'}).text,'')
  assert.equal(preview('*curto*').text,'*curto*')
})
