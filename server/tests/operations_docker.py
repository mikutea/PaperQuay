"""Disposable Linux/Docker rehearsal, never a production or device acceptance.

Build images first. Invoke with --allow-disposable-docker-writes; all generated
credentials, settings, backups and keys stay in one private temporary directory.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import secrets
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError
from urllib.request import build_opener, ProxyHandler, Request

spec = importlib.util.spec_from_file_location('paperquay_ops', Path(__file__).resolve().parents[1] / 'deploy/ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
sys.modules['ops'] = ops


def wait_for(action):
    for _ in range(120):
        try:
            if action():
                return
        except ops.OpsError:
            pass
        time.sleep(1)
    raise ops.OpsError('FIXTURE_START_TIMEOUT')


def identity_ready(response):
    headers, separator, body = response.replace('\r\n', '\n').partition('\n\n')
    if not separator or not re.match(r'^HTTP/1\.[01] 200\b', headers):
        return False
    try:
        return json.loads(body).get('status') == 'UP'
    except (ValueError, AttributeError):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-disposable-docker-writes', action='store_true', required=True)
    parser.parse_args()
    ops.require(os.name == 'posix', 'LINUX_REQUIRED')
    os.umask(0o077)
    directory = Path(__file__).resolve().parents[1] / 'deploy'
    images = {service: os.environ['PAPERQUAY_TEST_' + service.upper() + '_IMAGE'] for service in ops.SERVICES}
    ops.require(all(ops.PIN.fullmatch(image) for image in images.values()), 'IMAGE_DIGEST_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='paperquay-disposable-ops-') as temporary:
        target = Path(temporary).resolve()
        ops.require(target.parent == Path(tempfile.gettempdir()).resolve(), 'TEMP_SCOPE_INVALID')
        os.chmod(target, 0o700)

        def write(name, value, mode=0o600):
            (target / name).write_text(value, 'utf-8')
            os.chmod(target / name, mode)

        password = secrets.token_hex(24)
        erasure_password = secrets.token_hex(24)
        project = 'paperquay-ci-' + secrets.token_hex(6)
        config = (directory / 'compose.production.yml').read_text('utf-8')
        # Real Fastify/PG/Caddy anonymous paths; no successful authentication is
        # fabricated. JWT/HTTPS browser login has its separate acceptance suite.
        api = """
import {buildApp} from './src/app.ts';
import {loadConfig} from './src/config.ts';
import {PostgresSyncStore} from './src/store.ts';
import {ApiError} from './src/errors.ts';
const config=loadConfig();
const repository=new PostgresSyncStore({connectionString:config.databaseUrl,cursorSecret:config.cursorSecret});
const app=await buildApp({config,repository,logger:true,verifyToken:async()=>{throw new ApiError('AUTHENTICATION_REQUIRED',401);}});
await app.listen({host:config.host,port:config.port});
"""
        config = config.replace('    env_file: [sync.env]',
            '    command: ' + json.dumps(['node', '--input-type=module', '-e', api]) + '\n    env_file: [sync.env]')
        write('compose.production.yml', config)
        shutil.copyfile(directory / 'init-production.sql', target / 'init-production.sql')
        # The entrypoint switches to the postgres UID before reading this
        # secret-free template. The enclosing operator directory stays 0700.
        os.chmod(target / 'init-production.sql', 0o644)
        network = '172.30.' + str(10 + secrets.randbelow(200)) + '.'
        lines = ['PAPERQUAY_PROJECT=' + project, 'PAPERQUAY_LOCAL_PORT=14317',
                 'PAPERQUAY_APPLICATION_SUBNET=' + network + '0/24',
                 'PAPERQUAY_WEB_IP=' + network + '2', 'PAPERQUAY_INGRESS_PROXY_IPS=' + network + '1']
        lines.extend(ops.IMAGE_KEYS[service] + '=' + image for service, image in images.items())
        write('compose.env', '\n'.join(lines) + '\n')
        write('database.env', '\n'.join(name + '=' + password for name in ('POSTGRES_PASSWORD',
            'PAPERQUAY_MIGRATION_DB_PASSWORD', 'PAPERQUAY_RUNTIME_DB_PASSWORD', 'PAPERQUAY_IDENTITY_DB_PASSWORD'))
            + '\nPAPERQUAY_ERASURE_DB_PASSWORD=' + erasure_password + '\n')
        write('identity.env', 'KC_HOSTNAME=https://reader.example.test/identity\nKC_DB_PASSWORD=' + password
            + '\nKC_BOOTSTRAP_ADMIN_USERNAME=disposable-operator\nKC_BOOTSTRAP_ADMIN_PASSWORD=' + password + '\n')
        write('migration.env', 'PAPERQUAY_MIGRATION_DATABASE_URL=postgresql://paperquay_migrate:' + password + '@database:5432/paperquay\n')
        write('sync.env', 'PAPERQUAY_DATABASE_URL=postgresql://paperquay_runtime:' + password + '@database:5432/paperquay\n'
            + 'PAPERQUAY_ERASURE_DATABASE_URL=postgresql://paperquay_erasure:' + erasure_password + '@database:5432/paperquay\n'
            + 'PAPERQUAY_OIDC_ISSUER=https://reader.example.test/identity/realms/paperquay\n'
            + 'PAPERQUAY_OIDC_AUDIENCE=paperquay-sync\nPAPERQUAY_OIDC_CLIENT_IDS=paperquay-mobile\n'
            + 'PAPERQUAY_PRIVATE_METRICS_INTERVAL_SECONDS=15\n'
            + 'PAPERQUAY_CURSOR_SECRET=' + __import__('base64').b64encode(secrets.token_bytes(48)).decode() + '\n')
        write('runtime-config.json', json.dumps({'apiBaseUrl': 'https://reader.example.test/api',
            'oidcAuthority': 'https://reader.example.test/identity/realms/paperquay', 'oidcClientId': 'paperquay-mobile'}), 0o644)
        stack = None
        phase = 'configuration'
        health = ''
        try:
            stack = ops.Stack(target)
            phase = 'database_start'
            ops.run(stack.command('up', '-d', '--wait', '--wait-timeout', '120', 'database'), stdout=subprocess.DEVNULL)
            phase = 'schema_migration'
            ops.run(stack.command('run', '--rm', 'migrate'), stdout=subprocess.DEVNULL)
            phase = 'application_start'
            ops.run(stack.command('up', '-d', 'identity', 'sync', 'web'), stdout=subprocess.DEVNULL)
            opener = build_opener(ProxyHandler({}))

            def status(path, forwarded=None):
                request = Request('http://127.0.0.1:14317/api/' + path,
                                  headers={'X-Forwarded-For': forwarded} if forwarded else {})
                try:
                    with opener.open(request, timeout=5) as response:
                        response.read()
                        return response.status
                except HTTPError as error:
                    error.close()
                    return error.code

            wait_for(lambda: status('health/ready') == 200)
            phase = 'proxy_rate_limit'
            # The trusted fixture ingress appends the real client on the right.
            # Changing an attacker-controlled left entry cannot reset its limit.
            first = [status('v1/capabilities', '203.0.113.' + str(1 + index % 200) + ', 198.51.100.71')
                     for index in range(121)]
            ops.require(first == [200] * 120 + [429]
                        and status('v1/capabilities', '198.51.100.72') == 200, 'PROXY_CLIENT_ISOLATION_FAILED')
            # Two direct container peers must also have separate buckets, and
            # neither is a trusted ingress allowed to invent forwarding chains.
            client = """
const count=Number(process.argv[1]);const statuses=[];
for(let i=0;i<count;i++) {const r=await fetch('http://web:8080/api/v1/capabilities',
 {headers:{'X-Forwarded-For':'203.0.113.'+(1+i%200)},signal:AbortSignal.timeout(5000)});
 statuses.push(r.status);await r.arrayBuffer();}
console.log(JSON.stringify(statuses));
"""
            def direct(count, host):
                return json.loads(ops.capture(['docker', 'run', '--rm', '--network', project + '_application',
                    '--ip', network + str(host),
                    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m',
                    '--read-only', images['sync'], 'node', '--input-type=module', '-e', client, str(count)]))

            # Docker can reuse the first released dynamic IP immediately; use
            # two explicit peers so this actually tests two distinct clients.
            ops.require(direct(122, 10) == [200] * 120 + [429, 429] and direct(1, 11) == [200], 'PROXY_SPOOF_GUARD_FAILED')
            identity, _ = stack.container('identity')
            phase = 'identity_health'
            def check_identity():
                nonlocal health
                health = ops.capture(['docker', 'exec', identity, 'bash', '-c',
                    "exec 3<>/dev/tcp/127.0.0.1/9000; printf 'GET /health/ready HTTP/1.0\r\n\r\n' >&3; cat <&3"])
                return identity_ready(health)

            wait_for(check_identity)
            # A real realm and signing keys become part of the PostgreSQL dump.
            phase = 'identity_realm'
            import realm
            ops.run(['docker', 'exec', '-i', identity, 'sh', '-c', 'cat > /tmp/production-realm.json'],
                input=json.dumps(realm.production_realm('https://reader.example.test')).encode('utf-8'), stdout=subprocess.DEVNULL)
            ops.run(['docker', 'exec', identity, 'bash', '-c',
                '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/disposable-admin.json '
                '--server http://127.0.0.1:8080/identity --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" '
                '--password "$KC_BOOTSTRAP_ADMIN_PASSWORD" && '
                '/opt/keycloak/bin/kcadm.sh create realms --config /tmp/disposable-admin.json -f /tmp/production-realm.json'],
                stdout=subprocess.DEVNULL)
            mobile = json.loads(ops.capture(['docker', 'exec', identity, '/opt/keycloak/bin/kcadm.sh', 'get', 'clients',
                '--config', '/tmp/disposable-admin.json', '-r', 'paperquay', '-q', 'clientId=paperquay-mobile']))
            ops.require(len(mobile) == 1 and mobile[0]['publicClient']
                        and not mobile[0]['directAccessGrantsEnabled'] and not mobile[0]['implicitFlowEnabled']
                        and mobile[0]['attributes']['pkce.code.challenge.method'] == 'S256'
                        and 'basic' in mobile[0]['defaultClientScopes'], 'PRODUCTION_REALM_INVALID')
            sync, _ = stack.container('sync')
            seed = """
import {randomUUID,createHash} from 'node:crypto';
import {PostgresSyncStore} from './src/store.ts';
const store=new PostgresSyncStore({connectionString:process.env.PAPERQUAY_DATABASE_URL,cursorSecret:Buffer.from(process.env.PAPERQUAY_CURSOR_SECRET,'base64'),cloudPdfEnabled:true});
try {
 const who={issuer:'https://identity.example.test',subject:randomUUID(),sessionId:randomUUID(),clientId:'paperquay-mobile'};
 const view=await store.registerDevice(who,{name:'Disposable recovery fixture',platform:'web'});
 const op=(entityType,data,extra={})=>({opId:randomUUID(),entityType,entityId:randomUUID(),schemaVersion:1,mutation:'put',baseRevision:0,data,clientCreatedAt:new Date().toISOString(),...extra});
 const paper=op('paper',{title:'Recovery sentinel',doi:null,year:'2026',publication:null,abstractText:null,authors:[],keywords:[]});
 const content=Buffer.from('%PDF-1.7\\n'+'synthetic-byte-content'.repeat(1024)+'\\n%%EOF');
 const version=op('attachmentVersion',{paperId:paper.entityId,attachmentId:randomUUID(),sha256:createHash('sha256').update(content).digest('hex'),sizeBytes:content.length,mediaType:'application/pdf',fileName:'recovery.pdf',pageCount:1});
 const note=op('note',{paperId:paper.entityId,title:'Original note',body:'Recovery note body',format:'markdown'});
 for(const item of [paper,version,note]) {const result=await store.push(who,{protocolVersion:1,deviceId:view.device.id,operations:[item]});if(result.results[0].status!=='applied')throw Error('SEED_FAILED');}
 const result=await store.push(who,{protocolVersion:1,deviceId:view.device.id,operations:[op('note',{...note.data,body:'Conflicting note body'},{entityId:note.entityId})]});
 if(result.results[0].status!=='conflict')throw Error('CONFLICT_SEED_FAILED');
 const prepared=await store.prepareCloudPdfUpload(who,version.entityId);await store.putCloudPdf(who,version.entityId,content,prepared.generation);
 if(!(await store.ready()))throw Error('RUNTIME_NOT_READY');
} finally {await store.close();}
"""
            phase = 'business_seed'
            ops.run(['docker', 'exec', sync, 'node', '--input-type=module', '-e', seed], stdout=subprocess.DEVNULL)
            # Real Docker/SQL/log collection, not a fabricated monitoring receipt.
            import monitor
            phase = 'private_monitor'
            observed = monitor.sample(stack)
            ops.require(not observed['errors'] and observed['queues']['applicationDatabaseBytes'] > 0
                        and observed['http']['requests']['completed'] > 0
                        and all(value['running'] for value in observed['containers'].values()), 'MONITOR_FAILED')
            monitor.append_private(target, observed)
            baseline = {service: stack.container(service)[0] for service in ops.SERVICES}
            key = target / 'age-identity'
            ops.run(['age-keygen', '-o', str(key)], stdout=subprocess.DEVNULL)
            recipient = ops.capture(['age-keygen', '-y', str(key)]).strip()
            phase = 'encrypted_backup'
            receipt = ops.backup(stack, target / 'recovery.tar.age', recipient)
            ops.require(receipt['status'] == 'backed_up', 'BACKUP_FAILED')
            phase = 'restore_drill'
            result = ops.restore_drill(stack, target / 'recovery.tar.age', receipt['sha256'], key)
            ops.require(result['status'] == 'restored_and_verified', 'RESTORE_FAILED')
            ops.require(all(stack.container(service)[0] == baseline[service]
                            and stack.container(service)[1]['State']['Running'] for service in ops.SERVICES), 'SOURCE_STACK_CHANGED')
            damaged = target / 'damaged.age'
            shutil.copyfile(target / 'recovery.tar.age', damaged)
            with open(damaged, 'r+b') as file:
                file.seek(100)
                file.write(b'corruption-sentinel')
            try:
                ops.restore_drill(stack, damaged, receipt['sha256'], key)
                raise AssertionError('Corrupted backup was accepted')
            except ops.OpsError as error:
                ops.require(str(error) == 'BACKUP_CHECKSUM_MISMATCH', 'WRONG_CORRUPTION_RESULT')
            print(json.dumps({'status': 'passed', 'fullTableAndRoleHashes': True, 'cloudPdfBytes': True,
                'realIdentityRealm': True, 'sourceContainersUnchanged': True,
                'corruptionRejected': True, 'proxyClientIsolation': True, 'untrustedForwardingRejected': True,
                'restoreSeconds': result['restoreSeconds']}))
        except ops.OpsError as error:
            # This harness creates all inputs itself in a disposable fixture;
            # it never accepts a production directory or connection. Diagnostic
            # output is also stripped of its generated credentials and tokens.
            detail = getattr(error, '_stderr', b'').decode('utf-8', errors='replace')
            if phase in ('database_start', 'schema_migration') and stack:
                try:
                    database = stack.container('database')[0]
                    logs = subprocess.run(['docker', 'logs', '--tail', '60', database], stdout=subprocess.PIPE,
                        stderr=subprocess.STDOUT, timeout=15).stdout.decode('utf-8', errors='replace')
                    detail += '\n' + '\n'.join(line for line in logs.splitlines() if 'ERROR:' in line or 'FATAL:' in line)
                except Exception:
                    pass
            if phase == 'identity_health' and stack:
                try:
                    logs = subprocess.run(['docker', 'logs', '--tail', '60', stack.container('identity')[0]],
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=15).stdout.decode('utf-8', errors='replace')
                    detail += '\n' + health[:2048] + '\n' + logs
                except Exception:
                    pass
            for value in [password, *ops.read_env(target / 'sync.env').values()]:
                detail = detail.replace(value, '[redacted]')
            detail = re.sub(r'(?<=://)[^\s/@:]+:[^\s/@]+@', '[redacted]@', detail)
            detail = re.sub(r'\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b', '[redacted]', detail)
            detail = re.sub(r'AGE-SECRET-KEY-[A-Z0-9]+|SCRAM-SHA-256\$[^\s\x27\x22]+', '[redacted]', detail)
            print(json.dumps({'status': 'fixture_diagnostic', 'phase': phase, 'detail': detail[-4096:]}))
            raise
        finally:
            # This project name and its volumes were created by this invocation.
            if stack:
                ops.require(stack.project == project and project.startswith('paperquay-ci-'), 'TEARDOWN_SCOPE_INVALID')
                ops.run(stack.command('down', '--volumes'), stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': str(error) if isinstance(error, ops.OpsError) else 'REHEARSAL_FAILED'}))
        raise SystemExit(1)
