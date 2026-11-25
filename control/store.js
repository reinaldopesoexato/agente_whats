const {DatabaseSync} = require('node:sqlite')
const {randomBytes,randomUUID,createHash,scrypt,timingSafeEqual} = require('node:crypto')
const derive = require('node:util').promisify(scrypt)
const fs = require('node:fs')
const path = require('node:path')

const permissions = Object.freeze({users:'Gerenciar usuários',usage:'Consultar consumo',quota:'Alterar cotas',
  ai:'Configurar IA compartilhada',adminSkills:'Gerenciar skills administrativas',permissions:'Gerenciar permissões'})
const token = ()=>randomBytes(32).toString('base64url')
const digest = value=>createHash('sha256').update(value).digest('hex')
const error = (status,message)=>Object.assign(new Error(message),{status})
const emailAddress = raw=>{
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!/^[^\s@<>]{1,64}@[^\s@<>]+\.[^\s@<>]+$/.test(email) || email.length>254) throw error(400,'E-mail inválido.')
  return email
}
const SESSION = 30*86400000
function openStore(dir) {
  fs.mkdirSync(dir,{recursive:true,mode:0o700})
  const db = new DatabaseSync(path.join(dir,'accounts.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,password TEXT,enabled INTEGER NOT NULL,
      permissions TEXT NOT NULL,quotaGiB INTEGER NOT NULL,broker TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,uid TEXT REFERENCES users(id),expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY,uid TEXT REFERENCES users(id),parent TEXT NOT NULL,kind TEXT NOT NULL,expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS shared(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);
    INSERT OR IGNORE INTO shared VALUES(1,'{}');`)
  const sql = query=>db.prepare(query)
  if(!sql('PRAGMA table_info(users)').all().some(c=>c.name==='revision')) db.exec('ALTER TABLE users ADD COLUMN revision INTEGER NOT NULL DEFAULT 0')
  const rights = row=>JSON.parse(row.permissions)
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE')
    try {const result=fn();db.exec('COMMIT');return result} catch(e){db.exec('ROLLBACK');throw e}
  }
  db.exec('CREATE TABLE IF NOT EXISTS migrations(name TEXT PRIMARY KEY)')
  transaction(()=>{
    if(!sql("INSERT OR IGNORE INTO migrations VALUES('admin-skills-permission')").run().changes) return
    const legacy=['users','usage','quota','ai','permissions']
    for(const u of sql('SELECT id,permissions FROM users').all()) {
      const granted=rights(u)
      if(legacy.every(key=>granted.includes(key))&&!granted.includes('adminSkills'))
        sql('UPDATE users SET permissions=?,revision=revision+1 WHERE id=?').run(JSON.stringify([...granted,'adminSkills']),u.id)
    }
  })
  function create(email,bootstrap=false) {
    const id=randomUUID()
    email=emailAddress(email)
    if(sql('SELECT id FROM users WHERE email=?').get(email)) throw error(409,'E-mail já cadastrado.')
    sql('INSERT INTO users(id,email,password,enabled,permissions,quotaGiB,broker) VALUES(?,?,NULL,1,?,10,?)').run(id,email,JSON.stringify(bootstrap?Object.keys(permissions):[]),token())
    return id
  }
  function update(actor,id,changes,revision) {
    return transaction(()=>{
      const target=sql('SELECT * FROM users WHERE id=?').get(id)
      if(!target) throw error(404,'Usuário não encontrado.')
      if(revision!==undefined && target.revision!==revision) throw error(409,'Cadastro alterado por outra pessoa. Atualize a página.')
      const perms=rights(actor)
      const needed={enabled:'users',permissions:'permissions',quotaGiB:'quota'}
      for(const key of Object.keys(changes)) if(!Object.hasOwn(needed,key)||!perms.includes(needed[key])) throw error(403,'Permissão insuficiente.')
      const enabled=changes.enabled ?? Boolean(target.enabled)
      const next=changes.permissions ?? rights(target)
      const quota=changes.quotaGiB ?? target.quotaGiB
      if(typeof enabled!=='boolean'||!Array.isArray(next)||next.some(p=>!Object.hasOwn(permissions,p))||
        !Number.isInteger(quota)||quota<1||quota>4096) throw error(400,'Permissões ou cota inválidas.')
      const previous=rights(target)
      if([...new Set([...previous,...next])].some(p=>previous.includes(p)!==next.includes(p)&&!perms.includes(p))) throw error(403,'Você só pode delegar as permissões que possui.')
      if((!enabled||!next.includes('permissions')) && !sql('SELECT permissions FROM users WHERE id<>? AND enabled=1 AND password IS NOT NULL').all(id)
        .some(u=>rights(u).includes('permissions')) && previous.includes('permissions')) throw error(409,'Mantenha um gestor de permissões ativo.')
      sql('UPDATE users SET enabled=?,permissions=?,quotaGiB=?,revision=revision+1 WHERE id=?').run(Number(enabled),JSON.stringify([...new Set(next)]),quota,id)
      if(!enabled) invalidate(id)
    })
  }
  function invalidate(id) {
    sql('DELETE FROM sessions WHERE uid=?').run(id)
    sql('DELETE FROM tickets WHERE uid=?').run(id)
  }
  function issue(id,kind,parent='') {
    const value=token()
    sql('DELETE FROM tickets WHERE expires<=?').run(Date.now())
    if(kind==='password') sql("DELETE FROM tickets WHERE uid=? AND kind='password'").run(id)
    sql('INSERT INTO tickets VALUES(?,?,?,?,?)').run(digest(value),id,parent,kind,Date.now()+(kind==='password'?1800000:60000))
    return value
  }
  function consume(value,kind) {
    if(typeof value!=='string'||value.length!==43) throw error(403,'Link inválido ou vencido.')
    const row=sql('DELETE FROM tickets WHERE hash=? AND kind=? RETURNING *').get(digest(value),kind)
    if(!row||row.expires<=Date.now()) throw error(403,'Link inválido ou vencido.')
    return row
  }
  async function setPassword(value,password) {
    if(typeof password!=='string'||password.length<12||password.length>256) throw error(400,'Use uma senha de 12 a 256 caracteres.')
    if(typeof value!=='string'||!sql("SELECT uid FROM tickets WHERE hash=? AND kind='password' AND expires>?").get(digest(value),Date.now())) throw error(403,'Link inválido ou vencido.')
    const salt=token()
    const hash=await derive(password,salt,64)
    transaction(()=>{
      const {uid}=consume(value,'password')
      invalidate(uid)
      sql('UPDATE users SET password=? WHERE id=? AND enabled=1').run(salt+':'+hash.toString('hex'),uid)
    })
  }
  async function login(email,password) {
    const user=sql('SELECT * FROM users WHERE email=? AND enabled=1').get(emailAddress(email))
    const original=user?.password
    const [salt,hash]=(original||'unknown:'+ '00'.repeat(64)).split(':')
    if(typeof password!=='string'||password.length>256) throw error(401,'Login ou senha inválidos.')
    const actual=await derive(password,salt,64)
    if(!original||!timingSafeEqual(actual,Buffer.from(hash,'hex'))||
      !sql('SELECT id FROM users WHERE id=? AND password=? AND enabled=1').get(user.id,original)) throw error(401,'Login ou senha inválidos.')
    const value=token()
    sql('DELETE FROM sessions WHERE expires<=?').run(Date.now())
    sql('INSERT INTO sessions VALUES(?,?,?)').run(digest(value),user.id,Date.now()+SESSION)
    return value
  }
  function session(value) {
    return typeof value==='string'&&value.length===43 && sql('SELECT u.*,s.hash AS sessionHash FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=? AND s.expires>? AND u.enabled=1').get(digest(value),Date.now())
  }
  return {db,sql,create,update,rights,transaction,issue,consume,setPassword,login,session,
    shared:()=>JSON.parse(sql('SELECT value FROM shared WHERE id=1').get().value)}
}
module.exports={openStore,permissions,emailAddress,digest,SESSION,error,token}
