const {openStore,emailAddress}=require('./store')
process.umask(0o077)
const [command,email]=process.argv.slice(2)
const store=openStore('/control')
const address=emailAddress(email)
const link=store.transaction(()=>{
  let user=store.sql('SELECT * FROM users WHERE email=?').get(address)
  if(command==='init'){
    if(store.sql('SELECT 1 FROM users LIMIT 1').get()) return null
    user={id:store.create(address,true)}
  }else if(command==='grant-admin-skills' && user?.enabled) {
    const rights=store.rights(user)
    if(!rights.includes('adminSkills')) store.sql('UPDATE users SET permissions=?,revision=revision+1 WHERE id=?')
      .run(JSON.stringify([...rights,'adminSkills']),user.id)
    console.log('Permissão de skills administrativas concedida.')
    return null
  }else if(command!=='recover'||!user?.enabled) throw Error('Usuário indisponível.')
  return 'https://'+process.env.WHATSIA_DOMAIN+'/#senha='+store.issue(user.id,'password')
})
if(link) console.log('Defina a senha em até 30 minutos pelo link privado abaixo.\n'+link)
