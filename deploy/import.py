#!/usr/bin/env python3
"""Explicit offline import from stdin. An interrupted import leaves this user paused."""
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from supervise import BASE, CONF, RUNTIME, disk, inspect, run, save_status

address=sys.argv[1].lower()
with (BASE/'supervision.lock').open('a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    with sqlite3.connect('file:'+str(BASE/'control/accounts.sqlite')+'?mode=ro',uri=True) as db:
        row=db.execute('SELECT id,quotaGiB FROM users WHERE email=?',(address,)).fetchone()
    if not row: sys.exit('Usuário não encontrado.')
    uid,gib=row
    assert str(uuid.UUID(uid))==uid
    root=disk(uid,gib)
    image=(CONF/'worker-image').read_text().strip()
    cmd=['docker','run','--rm','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges',
         '--read-only','--pids-limit','64','--memory','1g','--user','1000:1000']
    # Never replace a tenant already carrying accounts or messages.
    check="""const fs=require('fs');for(const f of ['/persist/context/state.json','/persist/data/state.json']){
    if(fs.existsSync(f)){const s=JSON.parse(fs.readFileSync(f));if(s.accounts?.length||s.messages?.length)process.exit(2)}}
    """
    if subprocess.run(cmd+['-v',str(root)+':/persist:ro','--entrypoint','node',image,'-e',check]).returncode:
        sys.exit('O destino já contém contas ou mensagens. Importação cancelada.')
    stage=Path(tempfile.mkdtemp(prefix='import-',dir=root))
    os.chown(stage,1000,1000)
    result=subprocess.run(cmd+['-i','-v',str(stage)+':/import','--entrypoint','tar',image,
                               '--no-same-owner','--no-same-permissions','-xf','-','-C','/import'])
    if result.returncode: sys.exit('Cópia incompleta. A instalação anterior permanece ativa.')
    check="""const fs=require('fs');for(const n of ['data','context'])if(!fs.lstatSync('/import/'+n).isDirectory())process.exit(2);
    const s=JSON.parse(fs.readFileSync('/import/context/state.json'));if(!Array.isArray(s.accounts))process.exit(2)"""
    subprocess.run(cmd+['-v',str(stage)+':/import:ro','--entrypoint','node',image,'-e',check],check=True)
    paused=BASE/'paused'/uid
    was_paused=paused.exists()
    paused.touch()
    name='whatsia-u-'+uid
    if inspect(name): run('docker','stop','-t','75',name)
    save_status(uid,{'paused':True,'ready':False})
    backup=Path(tempfile.mkdtemp(prefix='before-import-',dir=root))
    # Keep previous directories so a failure is recoverable by the SSH operator.
    for sub in ('context','data'):
        (root/sub).rename(backup/sub)
        (stage/sub).rename(root/sub)
    if not was_paused: paused.unlink()
    print('Importação concluída. Dados anteriores preservados em', backup)
