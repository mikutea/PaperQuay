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
import shutil
import subprocess
import tempfile
import time

spec = importlib.util.spec_from_file_location('paperquay_ops', Path(__file__).resolve().parents[1] / 'deploy/ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


def wait_for(action):
    for _ in range(120):
        try:
            if action():
                return
        except ops.OpsError:
            pass
        time.sleep(1)
    raise ops.OpsError('FIXTURE_START_TIMEOUT')


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
        project = 'paperquay-ci-' + secrets.token_hex(6)
        config = (directory / 'compose.production.yml').read_text('utf-8')
        # Real database, identity and web containers. The server image's modules
        # and store are exercised below; a JWT/HTTPS browser flow belongs to its
        # separate acceptance suite and is not claimed by this recovery test.
        config = config.replace('    env_file: [sync.env]',
            '    command: [node, -e, "setInterval(() => {}, 60000)"]\n    env_file: [sync.env]')
        config = config.replace("      test: [CMD, node, -e, \"fetch('http://127.0.0.1:4311/health/ready',{signal:AbortSignal.timeout(3000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))\"]",
                                '      disable: true')
        write('compose.production.yml', config)
        shutil.copyfile(directory / 'init-production.sql', target / 'init-production.sql')
        lines = ['PAPERQUAY_PROJECT=' + project, 'PAPERQUAY_LOCAL_PORT=14317']
        lines.extend(ops.IMAGE_KEYS[service] + '=' + image for service, image in images.items())
        write('compose.env', '\n'.join(lines) + '\n')
        write('database.env', '\n'.join(name + '=' + password for name in ('POSTGRES_PASSWORD',
            'PAPERQUAY_MIGRATION_DB_PASSWORD', 'PAPERQUAY_RUNTIME_DB_PASSWORD', 'PAPERQUAY_IDENTITY_DB_PASSWORD')) + '\n')
        write('identity.env', 'KC_HOSTNAME=https://reader.example.test/identity\nKC_DB_PASSWORD=' + password
            + '\nKC_BOOTSTRAP_ADMIN_USERNAME=disposable-operator\nKC_BOOTSTRAP_ADMIN_PASSWORD=' + password + '\n')
        write('migration.env', 'PAPERQUAY_MIGRATION_DATABASE_URL=postgresql://paperquay_migrate:' + password + '@database:5432/paperquay\n')
        write('sync.env', 'PAPERQUAY_DATABASE_URL=postgresql://paperquay_runtime:' + password + '@database:5432/paperquay\n'
            + 'PAPERQUAY_OIDC_ISSUER=https://reader.example.test/identity/realms/paperquay\n'
            + 'PAPERQUAY_OIDC_AUDIENCE=paperquay-sync\nPAPERQUAY_OIDC_CLIENT_IDS=paperquay-mobile\n'
            + 'PAPERQUAY_CURSOR_SECRET=' + __import__('base64').b64encode(secrets.token_bytes(48)).decode() + '\n')
        write('runtime-config.json', json.dumps({'apiBaseUrl': 'https://reader.example.test/api',
            'oidcAuthority': 'https://reader.example.test/identity/realms/paperquay', 'oidcClientId': 'paperquay-mobile'}), 0o644)
        stack = ops.Stack(target)
        try:
            ops.run(stack.command('up', '-d', '--wait', '--wait-timeout', '120', 'database'), stdout=subprocess.DEVNULL)
            ops.run(stack.command('run', '--rm', 'migrate'), stdout=subprocess.DEVNULL)
            ops.run(stack.command('up', '-d', 'identity', 'sync', 'web'), stdout=subprocess.DEVNULL)
            identity, _ = stack.container('identity')
            wait_for(lambda: '"status": "UP"' in ops.capture(['docker', 'exec', identity, 'bash', '-c',
                "exec 3<>/dev/tcp/127.0.0.1/9000; printf 'GET /health/ready HTTP/1.0\r\n\r\n' >&3; cat <&3"]))
            # A real realm and signing keys become part of the PostgreSQL dump.
            ops.run(['docker', 'exec', identity, 'bash', '-c',
                '/opt/keycloak/bin/kcadm.sh config credentials --config /tmp/disposable-admin.json '
                '--server http://127.0.0.1:8080/identity --realm master --user "$KC_BOOTSTRAP_ADMIN_USERNAME" '
                '--password "$KC_BOOTSTRAP_ADMIN_PASSWORD" && '
                '/opt/keycloak/bin/kcadm.sh create realms --config /tmp/disposable-admin.json -s realm=paperquay -s enabled=true'],
                stdout=subprocess.DEVNULL)
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
            ops.run(['docker', 'exec', sync, 'node', '--input-type=module', '-e', seed], stdout=subprocess.DEVNULL)
            baseline = {service: stack.container(service)[0] for service in ops.SERVICES}
            key = target / 'age-identity'
            ops.run(['age-keygen', '-o', str(key)], stdout=subprocess.DEVNULL)
            recipient = ops.capture(['age-keygen', '-y', str(key)]).strip()
            receipt = ops.backup(stack, target / 'recovery.tar.age', recipient)
            ops.require(receipt['status'] == 'backed_up', 'BACKUP_FAILED')
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
                'corruptionRejected': True, 'restoreSeconds': result['restoreSeconds']}))
        finally:
            # This project name and its volumes were created by this invocation.
            ops.require(stack.project == project and project.startswith('paperquay-ci-'), 'TEARDOWN_SCOPE_INVALID')
            ops.run(stack.command('down', '--volumes'), stdout=subprocess.DEVNULL)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': str(error) if isinstance(error, ops.OpsError) else 'REHEARSAL_FAILED'}))
        raise SystemExit(1)
