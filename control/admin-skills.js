const fs=require('node:fs')
const path=require('node:path')
const {randomUUID}=require('node:crypto')
const {error}=require('./store')

function catalog(dir) {
  const folder=path.join(dir,'skill-catalog'),file=path.join(folder,'rules.json')
  fs.mkdirSync(folder,{recursive:true,mode:0o755})
  fs.chmodSync(folder,0o755)
  function write(rows) {
    const tmp=file+'.'+randomUUID()
    try {
      fs.writeFileSync(tmp,JSON.stringify(rows),{flag:'wx',mode:0o600})
      fs.chmodSync(tmp,0o444)
      fs.renameSync(tmp,file)
    } finally {fs.rmSync(tmp,{force:true})}
  }
  if(!fs.existsSync(file)) write([])
  const list=()=>JSON.parse(fs.readFileSync(file,'utf8'))
  function change(id,input,remove=false) {
    const rows=list(),old=id && rows.find(r=>r.id===id)
    if(id&&!old) throw error(404,'Skill não encontrada.')
    if(old&&input?.revision!==old.revision) throw error(409,'A skill foi alterada. Reabra a lista.')
    if(remove){write(rows.filter(r=>r!==old));return}
    const {name,group='',instruction,action,active}=input||{}
    if(typeof name!=='string'||!name.trim()||name.length>100||typeof group!=='string'||group.length>200||
      typeof instruction!=='string'||(!instruction.trim()&&!group.trim())||instruction.length>4000||
      !['task','summary','draft'].includes(action)||typeof active!=='boolean') throw error(400,'Confira os campos da skill.')
    const row={id:id||randomUUID(),revision:(old?.revision||0)+1,name:name.trim(),group:group.trim(),
      instruction:instruction.trim(),action,active,since:Date.now()}
    if(old) rows[rows.indexOf(old)]=row
    else rows.push(row)
    write(rows)
    return row
  }
  return {list,change}
}
function registerAdminSkills(app,must,dir) {
  const rules=catalog(dir)
  app.use('/admin/skills',(req,res,next)=>{must(req,'adminSkills');next()})
  app.get('/admin/skills',(req,res)=>res.json(rules.list()))
  app.post('/admin/skills',(req,res)=>res.status(201).json(rules.change(null,req.body)))
  app.put('/admin/skills/:id',(req,res)=>res.json(rules.change(req.params.id,req.body)))
  app.delete('/admin/skills/:id',(req,res)=>{rules.change(req.params.id,req.body,true);res.sendStatus(204)})
}
module.exports={catalog,registerAdminSkills}
