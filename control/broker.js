const {error}=require('./store')
const modelKeys=['chatCloudModel','autoCloudModel','imageModel','visionCloudModel','chatLocalModel','autoLocalModel','visionLocalModel']
function publicDefaults(config) {
  return {...Object.fromEntries(modelKeys.filter(k=>config[k]).map(k=>[k,config[k]])),sharedKey:Boolean(config.apiKey)}
}
function updateDefaults(previous,changes) {
  const next={...previous}
  for(const [key,value] of Object.entries(changes)) {
    if(typeof value!=='string'||(key==='apiKey' ? value.length>1024||/\s/.test(value) :
      !modelKeys.includes(key)||!/^([a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,199})?$/.test(value))) throw error(400,'Configuração de IA inválida.')
    if(value) next[key]=value
    else delete next[key]
  }
  return next
}
// Build a fresh stateless request. No file IDs, conversations, tools or retrieval handles cross this boundary.
function providerBody(route,b) {
  const bad=()=>{throw error(400,'Formato de solicitação indisponível para a chave compartilhada.')}
  if(typeof b?.model!=='string'||!b.model.match(/^[a-zA-Z0-9][a-zA-Z0-9.:-]{0,150}$/)) bad()
  if(route==='images/generations') {
    if(typeof b.prompt!=='string'||b.prompt.length>32000) bad()
    return {model:b.model,prompt:b.prompt,size:b.size,quality:b.quality,output_format:'png',n:1}
  }
  if(route!=='responses'||!Array.isArray(b.input)||typeof b.instructions!=='string'||b.previous_response_id||b.conversation||b.tools) bad()
  const input=b.input.map(m=>{
    if(m.role!=='user'||!Array.isArray(m.content)) bad()
    return {role:'user',content:m.content.map(c=>{
      if(c.type==='input_text'&&typeof c.text==='string') return {type:c.type,text:c.text}
      if(c.type==='input_image'&&typeof c.image_url==='string'&&/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(c.image_url))
        return {type:c.type,image_url:c.image_url,detail:c.detail}
      return bad()
    })}
  })
  if(!Number.isInteger(b.max_output_tokens)||b.max_output_tokens<1||b.max_output_tokens>65536) bad()
  return {model:b.model,instructions:b.instructions,input,store:false,text:{format:{type:'json_object'}},max_output_tokens:b.max_output_tokens}
}
module.exports={providerBody,publicDefaults,updateDefaults,modelKeys}
