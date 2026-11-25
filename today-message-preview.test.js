const test = require('node:test')
const assert = require('node:assert/strict')
const {todayMessagePreview:preview} = require('./today-message-preview')

test('eventos de sincronização e mensagens vazias não geram prévias em Hoje', () => {
  assert.equal(preview({type:'notification_template',body:'',media:false}),'')
  assert.equal(preview({type:'protocol',body:'evento'}),'')
  assert.equal(preview({type:'chat',isNotification:true,body:'evento'}),'')
  assert.equal(preview({type:'chat',body:' \u200b '}),'')
  assert.equal(preview({type:'chat',body:' Bom dia '}),'Bom dia')
})

test('mídias têm prévia mesmo antes de concluir a análise', () => {
  assert.equal(preview({type:'ptt',body:'',media:true}),'Mensagem de voz')
  assert.equal(preview({type:'ptt',transcript:'Até amanhã'}),'Até amanhã')
  assert.equal(preview({type:'image',body:'A'.repeat(200),extracted:'Uma fotografia'}),'Uma fotografia')
  assert.equal(preview({type:'document',body:'',caption:'Orçamento'}),'Orçamento')
  assert.equal(preview({type:'image',media:true}),'Imagem')
})
