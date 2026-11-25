const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const {createProfileCache,downloadPhoto,imageType} = require('./profile-cache')

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'whatsia-profile-test-'))
  t.after(() => fs.rm(directory,{recursive:true,force:true}))
  return directory
}
const picture = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+cveMAAAAASUVORK5CYII=','base64')

test('reutiliza o download simultâneo e preserva o perfil por conta após reiniciar offline',async t => {
  const directory = await temporaryDirectory(t)
  const get = createProfileCache(directory)
  let calls = 0
  const load = async () => {calls++;return picture}
  const args = ['p','123@c.us','avatar',load]
  const photos = await Promise.all([get(...args),get(...args)])
  assert.equal(calls,1)
  assert.deepEqual(photos,[picture,picture])
  await get('p','123@c.us','about',async()=>Buffer.from('Disponível'))
  const offline = createProfileCache(directory)
  assert.deepEqual(await offline('p','123@c.us','avatar'),picture)
  assert.equal((await offline('p','123@c.us','about')).toString(),'Disponível')
  assert.equal(await offline('w','123@c.us','avatar'),null)
})

test('serve a última foto durante a atualização e preserva a cópia após falha',async t => {
  const directory = await temporaryDirectory(t)
  const get = createProfileCache(directory)
  const args = ['p','1@g.us','avatar']
  await get(...args,async()=>picture)
  const [file] = await fs.readdir(directory)
  await fs.utimes(path.join(directory,file),new Date(0),new Date(0))
  let started
  const refreshing = new Promise(resolve=>{started=resolve})
  assert.deepEqual(await get(...args,async()=>{started();throw Error('desconectado')}),picture)
  await refreshing
  assert.deepEqual(await createProfileCache(directory)(...args),picture)
})

test('cacheia ausência confirmada e rejeita conteúdo inválido de foto',async t => {
  const cache = createProfileCache(await temporaryDirectory(t))
  const args = ['p','123@lid','avatar']
  await cache(...args,()=>downloadPhoto(undefined))
  assert.equal((await cache(...args,()=>assert.fail('consulta repetida'))).length,0)
  const url = 'https://pps.whatsapp.net/example'
  assert.deepEqual(await downloadPhoto(url,async()=>new Response(picture)),picture)
  assert.equal(imageType(picture),'image/png')
  await assert.rejects(downloadPhoto(url,async()=>new Response('html')),/Formato/)
  await assert.rejects(downloadPhoto('https://whatsapp.net.example.org/image',()=>assert.fail()),/Endereço/)
  await assert.rejects(downloadPhoto(url,async()=>new Response('x',{headers:{'content-length':9999999}})),/indisponível/)
})
