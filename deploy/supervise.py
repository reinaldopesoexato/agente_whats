#!/usr/bin/env python3
"""Host-only reconciler. The application gateway has no Docker socket or access to user disks."""
import contextlib
import fcntl
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import time
import urllib.request
import uuid

BASE = Path('/var/lib/whatsia')
CONF = Path('/etc/whatsia')
RUNTIME = BASE / 'runtime'
def run(*args, capture=False):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                          stderr=subprocess.PIPE, text=True).stdout
def inspect(name):
    p = subprocess.run(['docker','container','inspect',name],capture_output=True,text=True)
    if p.returncode and 'No such' not in p.stderr: raise RuntimeError('Docker indisponível')
    return None if p.returncode else json.loads(p.stdout)[0]
def save_status(uid, value):
    tmp = RUNTIME / (uid+'.tmp')
    tmp.write_text(json.dumps(value))
    tmp.replace(RUNTIME / (uid+'.json'))
def disk(uid, gib):
    root = BASE / 'tenants' / uid
    image = BASE / 'disks' / (uid+'.ext4')
    root.mkdir(parents=True, exist_ok=True)
    image.parent.mkdir(exist_ok=True)
    size = (gib+1)*2**30
    if not image.exists():
        tmp = image.with_suffix('.building')
        with tmp.open('wb') as out: out.truncate(size)
        run('mkfs.ext4','-q','-m','0','-O','quota','-E','quotatype=usrquota',str(tmp))
        tmp.replace(image)
    if not os.path.ismount(root):
        run('mount','-o','loop,nodev,nosuid,usrquota',str(image),str(root))
    if image.stat().st_size < size:
        with image.open('r+b') as out: out.truncate(size)
    fs = os.statvfs(root)
    if fs.f_blocks*fs.f_frsize < size*.90:
        device=run('findmnt','-n','-o','SOURCE','--target',str(root),capture=True).strip()
        run('losetup','-c',device)
        run('resize2fs',device)
    # ext4 stores the quota in its journal. It is applied by the kernel to all worker processes (UID 1000).
    run('setquota','-u','1000','0',str(gib*1024*1024),'0','0',str(root))
    # Worker may modify its own subdirectories; never follow tenant-controlled links as root.
    for name in ('data','context','home'):
        directory=root/name
        directory.mkdir(exist_ok=True)
        if directory.is_symlink() or not directory.is_dir(): raise ValueError('Estrutura persistente inválida')
        os.chown(directory,1000,1000,follow_symlinks=False)
    return root
def health(port,secret):
    request=urllib.request.Request('http://127.0.0.1:'+str(port)+'/internal/health',
        headers={'Host':'127.0.0.1:3030','X-WhatsIA-Worker':secret})
    with urllib.request.urlopen(request,timeout=3) as response:
        data=json.loads(response.read(65536))
    def safe(text):
        return ''.join(ch for ch in str(text)[:100] if ch.isprintable())
    summary={k:int(data[k]) for k in ('accounts','connected','attention')}
    summary['byAccount']=[{'name':safe(a.get('name','')),'status':safe(a.get('status',''))}
                          for a in data.get('byAccount',[])[:200] if isinstance(a,dict)]
    return summary
def port_of(container):
    return int(container['NetworkSettings']['Ports']['3030/tcp'][0]['HostPort'])
def local_model(uid,mount,net):
    if (CONF/'ollama-shared').exists():
        gateway='whatsia-ollama-gateway'
        service=inspect(gateway)
        if not service: raise RuntimeError('Ollama compartilhado ausente')
        if net not in service['NetworkSettings']['Networks']:
            run('docker','network','connect','--alias','ollama',net,gateway)
        return
    setting=CONF/'ollama-image'
    name='whatsia-model-'+uid
    current=inspect(name)
    if not setting.exists():
        if current: run('docker','rm','-f',name)
        return
    image=setting.read_text().strip()
    if not image.startswith('ollama/ollama@sha256:') or len(image.split(':')[-1])!=64:
        raise ValueError('Configure o digest da imagem oficial do Ollama')
    if current and current['Config']['Image']!=image:
        run('docker','rm','-f',name)
        current=None
    if not current:
        run('docker','run','-d','--name',name,'--network',net,'--network-alias','ollama','--user','1000:1000',
            '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--memory','8g','--cpus','2',
            '--tmpfs','/tmp:size=256m','--log-opt','max-size=5m','--log-opt','max-file=2',
            '-v',str(mount)+':/persist','-e','HOME=/persist/home','-e','OLLAMA_HOST=0.0.0.0:11434',image)
    elif not current['State']['Running']: run('docker','start',name)

def managed_evaluator(uid,image,net,domain,secret):
    # Separate filesystem and process namespace; the worker's command runner cannot read this mount.
    name='whatsia-rules-'+uid
    current=inspect(name)
    if current and current['Config']['Image']!=image:
        run('docker','rm','-f',name)
        current=None
    if not current:
        run('docker','run','-d','--name',name,'--network',net,'--network-alias','managed-rules',
            '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','1000:1000',
            '--memory','384m','--pids-limit','64','--add-host',domain+':host-gateway',
            '--log-opt','max-size=1m','--log-opt','max-file=2',
            '-v',str(RUNTIME/'defaults')+':/etc/whatsia/defaults:ro',
            '--mount','type=bind,source='+str(BASE/'control/skill-catalog')+',target=/rules,readonly',
            '-e','OLLAMA_URL=http://ollama:11434',
            '-e','WHATSIA_BROKER_URL=https://'+domain+'/shared','-e','WHATSIA_BROKER_TOKEN='+secret,
            image,'node','managed-evaluator.js')
    elif not current['State']['Running']: run('docker','start',name)

def update(row,image,domain):
    uid,email,enabled,gib,secret=row
    if str(uuid.UUID(uid))!=uid or not 1<=gib<=4096: raise ValueError('Cadastro inválido')
    name='whatsia-u-'+uid
    worker=inspect(name)
    if not enabled or (BASE/'paused'/uid).exists():
        if worker and worker['State']['Running']: run('docker','stop','-t','75',name)
        evaluator=inspect('whatsia-rules-'+uid)
        if evaluator and evaluator['State']['Running']: run('docker','stop','whatsia-rules-'+uid)
        model=inspect('whatsia-model-'+uid)
        if model and model['State']['Running']: run('docker','stop','whatsia-model-'+uid)
        prior=RUNTIME/(uid+'.json')
        value=json.loads(prior.read_text()) if prior.exists() else {}
        save_status(uid,dict(value,ready=False,paused=True))
        return
    mount=disk(uid,gib)
    fs=os.statvfs(mount)
    used=(fs.f_blocks-fs.f_bfree)*fs.f_frsize
    net='whatsia-'+uid
    previous=name+'-previous'
    blocked_marker=BASE / ('failed-'+uid)
    if worker and blocked_marker.exists() and blocked_marker.read_text()==image+':'+str(gib):
        if not worker['State']['Running']:
            run('docker','start',name)
            worker=inspect(name)
        port=port_of(worker)
        save_status(uid,dict(health(port,secret),used=used,port=port,ready=True,image=worker['Config']['Image'],updateFailed=True))
        raise RuntimeError('Atualização pendente; versão anterior ativa.')
    backup=inspect(previous)
    if not worker and backup:
        run('docker','rename',previous,name)
        worker=inspect(name)
        backup=None
    if not worker or worker['Config']['Image']!=image or worker['Config']['Labels'].get('whatsia.quota')!=str(gib):
        if subprocess.run(['docker','network','inspect',net],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode:
            run('docker','network','create',net)
        if backup: run('docker','rm',previous)
        if worker:
            run('docker','stop','-t','75',name)
            run('docker','rename',name,previous)
        try:
            run('docker','run','-d','--name',name,'--hostname','u-'+uid,'--network',net,'--label','whatsia.quota='+str(gib),
                '--read-only','--cap-drop=ALL','--security-opt','no-new-privileges','--pids-limit','768',
                '--memory',os.getenv('WORKER_MEMORY','3g'),'--cpus',os.getenv('WORKER_CPUS','2'),'--add-host',domain+':host-gateway',
                '--tmpfs','/tmp:rw,nosuid,nodev,size=256m','--shm-size','256m','--user','1000:1000',
                '--log-opt','max-size=5m','--log-opt','max-file=2','-p','127.0.0.1::3030',
                '-v',str(mount)+':/persist','-v',str(RUNTIME/'defaults')+':/etc/whatsia/defaults:ro',
                '-e','WHATSIA_RULES_URL=http://managed-rules:3041/evaluate','-e','OLLAMA_URL=http://ollama:11434',
                '-e','WHATSIA_QUOTA_GIB='+str(gib),
                '-e','WHATSIA_BROKER_URL=https://'+domain+'/shared','-e','WHATSIA_BROKER_TOKEN='+secret,image)
            worker=inspect(name)
            for attempt in range(60):
                try: health(port_of(worker),secret); break
                except (OSError,ValueError):
                    if attempt==59: raise
                    time.sleep(1)
            if inspect(previous): run('docker','rm',previous)
        except Exception:
            if inspect(name): run('docker','rm','-f',name)
            if inspect(previous):
                run('docker','rename',previous,name)
                run('docker','start',name)
                blocked_marker.write_text(image+':'+str(gib))
            raise
    elif not worker['State']['Running']:
        run('docker','start',name)
        worker=inspect(name)
    port=port_of(worker)
    summary=health(port,secret)
    managed_evaluator(uid,image,net,domain,secret)
    local_model(uid,mount,net)
    save_status(uid,dict(summary,used=used,port=port,ready=True,image=worker['Config']['Image']))
def reconcile():
    db=BASE/'control/accounts.sqlite'
    if not db.exists(): return 0
    failures=0
    with contextlib.closing(sqlite3.connect('file:'+str(db)+'?mode=ro',uri=True)) as conn:
        rows=conn.execute('SELECT id,email,enabled,quotaGiB,broker FROM users').fetchall()
    for row in rows:
        try: update(row,(CONF/'worker-image').read_text().strip(),(CONF/'domain').read_text().strip())
        except Exception as exc:
            output=(exc.stderr or '') if isinstance(exc,subprocess.CalledProcessError) else type(exc).__name__
            print('Espaço',row[0], 'pendente:',output.replace(row[4],'[omitido]')[:500],file=sys.stderr,flush=True)
            current=inspect('whatsia-u-'+row[0])
            try:
                if not current or not current['State']['Running']: raise ValueError('stopped')
                port=port_of(current)
                save_status(row[0],dict(health(port,row[4]),ready=True,port=port,image=current['Config']['Image'],updateFailed=True))
            except (OSError,ValueError,KeyError): save_status(row[0],{'ready':False})
            failures+=1
    return failures
if __name__=='__main__':
    RUNTIME.mkdir(parents=True,exist_ok=True)
    with (BASE/'supervision.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        sys.exit(bool(reconcile()))
