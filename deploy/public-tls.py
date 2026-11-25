#!/usr/bin/env python3
"""Provision public HTTPS for the portal and registered workspaces. Run as root."""
import fcntl
from pathlib import Path
import re
import socket
import sqlite3
import subprocess
import sys
import time
import uuid

CONF = Path('/etc/whatsia')
SITE = Path('/etc/nginx/conf.d')
WEBROOT = Path('/var/www/whatsia-acme')
LIVE = Path('/etc/letsencrypt/live')
DB = Path('/var/lib/whatsia/control/accounts.sqlite')

def run(*args):
    subprocess.run(args, check=True)

def publish(path, content):
    previous = path.read_bytes() if path.exists() else None
    data = content.encode()
    if previous == data:
        return
    temp = path.with_suffix('.next')
    temp.write_bytes(data)
    temp.replace(path)
    try:
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
    except Exception:
        if previous is None:
            path.unlink()
        else:
            temp.write_bytes(previous)
            temp.replace(path)
        raise

def addresses(host):
    try:
        return {info[4][0] for info in socket.getaddrinfo(host, 80, type=socket.SOCK_STREAM)}
    except socket.gaierror:
        return set()

def certificate(host, email, portal=False):
    name = 'whatsia-' + host
    directory = LIVE / name
    if all((directory / file).is_file() for file in ('fullchain.pem', 'privkey.pem')):
        return directory
    retry = CONF / 'tls-retry' / host
    if retry.exists() and time.time() - retry.stat().st_mtime < 21600:
        if portal:
            raise RuntimeError('Emissão do portal em espera após falha. Consulte o log do Certbot.')
        return None
    retry.parent.mkdir(mode=0o700, exist_ok=True)
    try:
        run('certbot', 'certonly', '--non-interactive', '--agree-tos',
            '--server', 'https://acme-v02.api.letsencrypt.org/directory',
            '--email', email, '--webroot', '-w', str(WEBROOT),
            '--cert-name', name, '-d', host)
    except subprocess.CalledProcessError:
        retry.touch()
        if portal:
            raise
        print('Emissão pendente:', host, file=sys.stderr)
        return None
    retry.unlink(missing_ok=True)
    return directory

def tls_server(host, directory, *, workspace=False):
    # UUID hostnames can exceed the default Nginx hash bucket. Match them exactly.
    server_name = "~^" + host.replace(".", r"\.") + "$" if workspace else host
    return f"""server {{
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name {server_name};
  ssl_certificate {directory}/fullchain.pem;
  ssl_certificate_key {directory}/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  client_max_body_size 18m;
  add_header Strict-Transport-Security "max-age=31536000" always;
  location / {{
    proxy_pass http://127.0.0.1:3040;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 600s;
    access_log off;
  }}
}}
"""

def configure():
    domain = (CONF / 'domain').read_text().strip()
    email = (CONF / 'acme-email').read_text().strip()
    if len(domain) > 210 or not re.fullmatch(r'[a-z0-9]+(?:[.-][a-z0-9]+)+', domain):
        raise ValueError('Domínio inválido')
    WEBROOT.mkdir(mode=0o755, parents=True, exist_ok=True)
    publish(SITE / 'whatsia-http.conf', f"""server {{
  listen 80;
  listen [::]:80;
  server_name {domain} *.{domain};
  location ^~ /.well-known/acme-challenge/ {{
    root {WEBROOT};
    try_files $uri =404;
  }}
  location / {{ return 308 https://$host$request_uri; }}
}}
""")
    servers = [tls_server(domain, certificate(domain, email, portal=True))]
    if DB.is_file():
        with sqlite3.connect(DB.as_uri() + '?mode=ro', uri=True) as db:
            ids = db.execute('SELECT id FROM users WHERE enabled=1 ORDER BY id').fetchall()
        portal_ips = addresses(domain)
        for (uid,) in ids:
            if str(uuid.UUID(uid)) != uid:
                raise ValueError('Identificador de espaço inválido')
            host = uid + '.' + domain
            # Keep serving existing certificates even during a DNS outage.
            existing = (LIVE / ('whatsia-' + host) / 'fullchain.pem').is_file()
            if not existing:
                ips = addresses(host)
                if not ips or not ips.issubset(portal_ips):
                    print('Aguardando DNS:', host)
                    continue
            directory = certificate(host, email)
            if directory:
                servers.append(tls_server(host, directory, workspace=True))
    publish(SITE / 'whatsia.conf', ''.join(servers))

if __name__ == '__main__':
    with (CONF / 'tls.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        configure()
