#!/usr/bin/env python3
"""Private, dedicated-stack backup and recovery. No host or account discovery.

Run on Linux as the existing Docker operator. Configuration, encrypted backups
and receipts must be outside Git. Output contains codes and hashes, not secrets.
"""
import argparse
import contextlib
import datetime
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import urlsplit

SETTINGS = ('compose.production.yml', 'compose.env', 'database.env', 'identity.env',
            'sync.env', 'migration.env', 'runtime-config.json', 'init-production.sql')
SERVICES = ('database', 'identity', 'sync', 'web')
IMAGE_KEYS = dict(zip(SERVICES, ('PAPERQUAY_POSTGRES_IMAGE', 'PAPERQUAY_IDENTITY_IMAGE',
                               'PAPERQUAY_SYNC_IMAGE', 'PAPERQUAY_WEB_IMAGE')))
DATABASES = ('paperquay', 'paperquay_identity')
PIN = re.compile(r'(?:sha256:[0-9a-f]{64}|[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[0-9a-f]{64})')
MAX_ARCHIVE_BYTES = 32 * 1024**3


class OpsError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise OpsError(code)


def utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def digest(path):
    value = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return value.hexdigest()


def check_archive_sizes(sizes, code='BACKUP_INVALID'):
    require(all(0 <= size <= MAX_ARCHIVE_BYTES for size in sizes)
            and sum(sizes) <= MAX_ARCHIVE_BYTES, code)


def run(args, **kwargs):
    # Never propagate command arguments, database output, or exception details.
    try:
        result = subprocess.run(args, stderr=subprocess.PIPE, timeout=1800, **kwargs)
    except (OSError, subprocess.TimeoutExpired):
        raise OpsError('OPERATION_FAILED') from None
    if result.returncode != 0:
        error = OpsError('OPERATION_FAILED')
        # Retained only for the calling operator/test harness. The production
        # CLI prints the code, never this possibly sensitive process output.
        error._stderr = (result.stderr or b'')[-8192:]
        raise error
    return result


def capture(args):
    return run(args, stdout=subprocess.PIPE).stdout.decode('utf-8')


def private_directory(path):
    path = Path(path).absolute()
    require(not path.is_symlink() and path.resolve() == path, 'PRIVATE_DIRECTORY_REQUIRED')
    require(path.is_dir(), 'PRIVATE_DIRECTORY_REQUIRED')
    require(not any((parent / '.git').exists() for parent in (path, *path.parents)), 'OUTSIDE_GIT_REQUIRED')
    info = path.stat()
    require(info.st_uid == os.geteuid() and not stat.S_IMODE(info.st_mode) & 0o077, 'PRIVATE_DIRECTORY_REQUIRED')
    return path


@contextlib.contextmanager
def operation_lock(directory):
    import fcntl
    descriptor = os.open(directory / '.operations.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise OpsError('ANOTHER_OPERATION_RUNNING') from None
        yield
    finally:
        os.close(descriptor)


def read_env(path):
    result = {}
    for line in path.read_text('utf-8').splitlines():
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.partition('=')
        require(bool(sep) and re.fullmatch(r'[A-Z][A-Z0-9_]*', key) and key not in result,
                'SETTINGS_INVALID')
        # Generated operator files use literal, unquoted values. Reject Compose
        # interpolation rather than silently resolve an unrelated shell value.
        require(value and not any(c in value for c in '\x00\r\n$\'"'), 'SETTINGS_INVALID')
        result[key] = value
    return result


def proxy_addresses(env):
    try:
        network = ipaddress.ip_network(env.get('PAPERQUAY_APPLICATION_SUBNET', ''), strict=True)
        web = ipaddress.ip_address(env.get('PAPERQUAY_WEB_IP', ''))
        peers = env.get('PAPERQUAY_INGRESS_PROXY_IPS', '').split()
        ingress = [ipaddress.ip_address(value) for value in peers]
        private = ('10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16')
        require(network.version == 4 and any(network.subnet_of(ipaddress.ip_network(value)) for value in private)
                and 24 <= network.prefixlen <= 28
                and web.version == 4 and web in network and web not in (network.network_address, network.broadcast_address)
                and web != network.network_address + 1
                and 1 <= len(ingress) <= 8
                and all(not value.is_unspecified and not value.is_multicast for value in ingress),
                'PROXY_SCOPE_INVALID')
    except ValueError:
        raise OpsError('PROXY_SCOPE_INVALID') from None
    return str(web)


class Stack:
    def __init__(self, directory):
        self.directory = private_directory(directory)
        for name in SETTINGS:
            path = self.directory / name
            require(path.is_file() and not path.is_symlink(), 'SETTINGS_MISSING')
            require(path.stat().st_uid == os.geteuid(), 'SETTINGS_OWNER_INVALID')
            if name.endswith('.env'):
                require(not stat.S_IMODE(path.stat().st_mode) & 0o077, 'PRIVATE_SETTINGS_REQUIRED')
        self.env = read_env(self.directory / 'compose.env')
        self.project = self.env.get('PAPERQUAY_PROJECT', '')
        require(re.fullmatch(r'paperquay-[a-z0-9][a-z0-9-]{0,39}', self.project), 'PROJECT_INVALID')
        require(all(PIN.fullmatch(self.env.get(key, '')) for key in IMAGE_KEYS.values()), 'IMAGE_DIGEST_REQUIRED')
        web_address = proxy_addresses(self.env)
        self.base = ['docker', 'compose', '--project-directory', str(self.directory),
                     '--env-file', str(self.directory / 'compose.env'), '-f', str(self.directory / 'compose.production.yml')]
        for name, key, user in [('sync.env', 'PAPERQUAY_DATABASE_URL', 'paperquay_runtime'),
                                ('migration.env', 'PAPERQUAY_MIGRATION_DATABASE_URL', 'paperquay_migrate')]:
            url = urlsplit(read_env(self.directory / name).get(key, ''))
            require(url.scheme in ('postgresql', 'postgres') and url.hostname == 'database'
                    and url.port in (None, 5432) and url.username == user and url.path == '/paperquay',
                    'DATABASE_SCOPE_INVALID')
        # Refuse a partial backup if a deployment has acquired untracked disk
        # mounts, secrets, or services. Compose output stays only in memory.
        configuration = json.loads(capture(self.command('--profile', 'maintenance', 'config', '--format', 'json')))
        require(configuration.get('name') == self.project
                and set(configuration.get('services', {})) == {*SERVICES, 'migrate'}, 'STACK_SCOPE_INVALID')
        require(configuration['services']['sync'].get('environment', {}).get('PAPERQUAY_TRUSTED_PROXY_IPS') == web_address
                and configuration['services']['web'].get('networks', {}).get('application', {}).get('ipv4_address') == web_address
                and configuration['services']['web'].get('environment', {}).get('PAPERQUAY_INGRESS_PROXY_IPS')
                    == self.env['PAPERQUAY_INGRESS_PROXY_IPS'],
                'PROXY_SCOPE_INVALID')
        mounts = {'database': {'/var/lib/postgresql': ('volume', 'database'),
                              '/docker-entrypoint-initdb.d/010-paperquay.sql': ('bind', str(self.directory / 'init-production.sql'))},
                  'identity': {}, 'sync': {}, 'migrate': {},
                  'web': {'/srv/runtime-config.json': ('bind', str(self.directory / 'runtime-config.json'))}}
        for service, settings in configuration['services'].items():
            require(not settings.get('secrets') and not settings.get('configs'), 'UNTRACKED_PERSISTENCE')
            actual = {entry['target']: (entry['type'], entry.get('source')) for entry in settings.get('volumes', [])}
            require(actual == mounts[service], 'UNTRACKED_PERSISTENCE')

    def command(self, *args):
        return self.base + list(args)

    def container(self, service):
        require(service in SERVICES, 'SERVICE_INVALID')
        ids = capture(self.command('ps', '--all', '--quiet', service)).split()
        require(len(ids) == 1 and re.fullmatch(r'[a-f0-9]{12,64}', ids[0]), 'STACK_NOT_INITIALIZED')
        metadata = json.loads(capture(['docker', 'inspect', ids[0]]))[0]
        labels = metadata['Config']['Labels'] or {}
        require(labels.get('com.docker.compose.project') == self.project
                and labels.get('com.docker.compose.service') == service, 'CONTAINER_SCOPE_MISMATCH')
        require(metadata['Config']['Image'] == self.env[IMAGE_KEYS[service]], 'CONTAINER_IMAGE_MISMATCH')
        return ids[0], metadata


def psql(container, database, sql):
    require(database in (*DATABASES, 'postgres'), 'DATABASE_INVALID')
    return ['docker', 'exec', '-e', 'PGOPTIONS=-c timezone=UTC', container,
            'psql', '-X', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', database, '-c', sql]


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def stream_digest(args):
    # Full rows (including bytea PDF/artifact content) are streamed through a
    # hash; they never enter logs, a command line, or an unbounded Python buffer.
    value = hashlib.sha256()
    with tempfile.TemporaryFile() as errors:
        try:
            process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=errors)
            try:
                for chunk in iter(lambda: process.stdout.read(1024 * 1024), b''):
                    value.update(chunk)
                require(process.wait(timeout=1800) == 0, 'DATABASE_READ_FAILED')
            finally:
                process.stdout.close()
                if process.poll() is None:
                    process.kill()
                    process.wait()
        except (OSError, subprocess.TimeoutExpired):
            raise OpsError('DATABASE_READ_FAILED') from None
    return value.hexdigest()


def fingerprints(container):
    result = {}
    for database in DATABASES:
        tables = json.loads(capture(psql(container, database, "SELECT coalesce(json_agg(t), '[]') FROM "
            "(SELECT schemaname, tablename FROM pg_tables WHERE schemaname NOT LIKE 'pg_%' "
            "AND schemaname <> 'information_schema' ORDER BY schemaname, tablename) t")))
        require(bool(tables), 'DATABASE_EMPTY')
        result[database] = {}
        for table in tables:
            key = table['schemaname'] + '.' + table['tablename']
            name = identifier(table['schemaname']) + '.' + identifier(table['tablename'])
            count = int(capture(psql(container, database, 'SELECT count(*) FROM ' + name)).strip())
            checksum = stream_digest(psql(container, database,
                'COPY (SELECT to_jsonb(t)::text FROM ' + name + ' t ORDER BY to_jsonb(t)::text COLLATE "C") TO STDOUT'))
            result[database][key] = {'rows': count, 'sha256': checksum}
    result['roles'] = stream_digest(psql(container, 'postgres',
        "COPY (SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,"
        "rolbypassrls,rolconnlimit,rolpassword,rolvaliduntil FROM pg_authid "
        "WHERE rolname NOT LIKE 'pg_%' AND rolname <> 'paperquay_restore_bootstrap' ORDER BY rolname) TO STDOUT"))
    return result


def known_schema():
    directory = Path(__file__).resolve().parent.parent / 'migrations'
    result = []
    for path in sorted(directory.glob('[0-9][0-9][0-9]_*.sql')):
        source = path.read_bytes().replace(b'\r\n', b'\n')
        result.append({'version': path.name, 'checksum': hashlib.sha256(source).hexdigest()})
    require(bool(result), 'SCHEMA_CATALOG_MISSING')
    return result


def schema_status(applied, known):
    require(isinstance(applied, list) and len(applied) <= len(known)
            and applied == known[:len(applied)], 'SCHEMA_UNSUPPORTED')
    return 'compatible' if applied == known else 'upgrade_required'


def current_schema(container):
    return json.loads(capture(psql(container, 'paperquay',
        "SELECT coalesce(json_agg(t), '[]') FROM (SELECT version,checksum FROM paperquay.schema_migrations ORDER BY version) t")))


@contextlib.contextmanager
def quiesce(stack):
    previously_running = []
    for service in ('sync', 'identity'):
        _, metadata = stack.container(service)
        if metadata['State']['Running']:
            previously_running.append(service)
    try:
        if previously_running:
            run(stack.command('stop', '--timeout', '60', *previously_running), stdout=subprocess.DEVNULL)
        # Confirm quiescence after both containers have stopped, even if a
        # process needed the timeout. This never stops another Compose project.
        for service in ('sync', 'identity'):
            require(not stack.container(service)[1]['State']['Running'], 'QUIESCE_FAILED')
        yield
    finally:
        if previously_running:
            run(stack.command('start', *previously_running), stdout=subprocess.DEVNULL)


def backup(stack, output, recipient):
    output = Path(output).absolute()
    private_directory(output.parent)
    require(output.suffix == '.age' and not output.exists() and not output.is_symlink(), 'NEW_BACKUP_PATH_REQUIRED')
    require(re.fullmatch(r'age1[0-9a-z]{58}', recipient or ''), 'AGE_RECIPIENT_REQUIRED')
    require(shutil.which('age'), 'AGE_REQUIRED')
    database, _ = stack.container('database')
    databases = json.loads(capture(psql(database, 'postgres',
        "SELECT json_agg(datname ORDER BY datname) FROM pg_database WHERE NOT datistemplate")))
    require(databases == sorted(['postgres', *DATABASES]), 'DEDICATED_CLUSTER_REQUIRED')
    images = {service: stack.container(service)[1]['Image'] for service in SERVICES}
    image_bytes = sum(json.loads(capture(['docker', 'image', 'inspect', value]))[0]['Size'] for value in set(images.values()))
    database_bytes = int(capture(psql(database, 'postgres',
        "SELECT sum(pg_database_size(datname)) FROM pg_database WHERE datname IN ('paperquay','paperquay_identity')")).strip())
    estimate = image_bytes + database_bytes * 4 + 512 * 1024**2
    require(shutil.disk_usage(stack.directory).free > estimate * 2
            and shutil.disk_usage(output.parent).free > estimate, 'BACKUP_SPACE_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='paperquay-backup-', dir=stack.directory) as temporary:
        stage = Path(temporary)
        os.chmod(stage, 0o700)
        with quiesce(stack):
            quiesced_at = utc()
            applied = current_schema(database)
            schema_status(applied, known_schema())
            inventory = fingerprints(database)
            with open(stage / 'cluster.sql', 'xb') as sql:
                run(['docker', 'exec', database, 'pg_dumpall', '-U', 'postgres', '--clean', '--if-exists'], stdout=sql)
            settings = stage / 'settings'
            settings.mkdir(mode=0o700)
            for name in SETTINGS:
                shutil.copyfile(stack.directory / name, settings / name)
                os.chmod(settings / name, 0o600)
            files = [stage / 'cluster.sql', *(settings / name for name in SETTINGS)]
            manifest = {'formatVersion': 1, 'quiescedAt': quiesced_at, 'createdAt': utc(),
                        'project': stack.project, 'images': images, 'schema': applied, 'fingerprints': inventory,
                        'files': {path.relative_to(stage).as_posix(): {'bytes': path.stat().st_size, 'sha256': digest(path)} for path in files}}
        # Exact runtime images are included for an offline disaster recovery.
        # Saving by immutable ID does not change tags or running containers.
        run(['docker', 'image', 'save', '--output', str(stage / 'images.tar'), *sorted(set(images.values()))], stdout=subprocess.DEVNULL)
        manifest['files']['images.tar'] = {'bytes': (stage / 'images.tar').stat().st_size, 'sha256': digest(stage / 'images.tar')}
        (stage / 'manifest.json').write_text(json.dumps(manifest, sort_keys=True), 'utf-8')
        # Match the recovery reader's complete uncompressed payload limit,
        # including the manifest itself. Never publish an unusable receipt.
        check_archive_sizes([(stage / name).stat().st_size for name in ('manifest.json', *manifest['files'])],
                            'BACKUP_TOO_LARGE')
        # Services resume before compression/encryption. No plain backup leaves
        # the restricted temporary directory; even config and cursor keys are encrypted.
        partial = output.with_name(output.name + '.partial')
        require(not partial.exists() and not partial.is_symlink(), 'NEW_BACKUP_PATH_REQUIRED')
        created_partial = False
        try:
            encrypted = open(partial, 'xb')
            created_partial = True
            with encrypted, tempfile.TemporaryFile() as errors:
                process = subprocess.Popen(['age', '-r', recipient], stdin=subprocess.PIPE, stdout=encrypted, stderr=errors)
                try:
                    with tarfile.open(fileobj=process.stdin, mode='w|gz') as archive:
                        for name in ('manifest.json', *manifest['files']):
                            archive.add(stage / name, arcname=name, recursive=False)
                    process.stdin.close()
                    require(process.wait(timeout=1800) == 0, 'BACKUP_ENCRYPTION_FAILED')
                finally:
                    if process.poll() is None:
                        process.kill()
                        process.wait()
                encrypted.flush()
                os.fsync(encrypted.fileno())
            os.chmod(partial, 0o600)
            # Hard-link creation is exclusive, so an operator's existing backup
            # can never be replaced between the initial check and publication.
            os.link(partial, output)
            return {'status': 'backed_up', 'sha256': digest(output), 'quiescedAt': quiesced_at,
                    'completedAt': utc(), 'schema': applied}
        finally:
            if created_partial and partial.exists():
                partial.unlink()


def unpack(archive_path, target):
    allowed = {'manifest.json', 'cluster.sql', 'images.tar', *('settings/' + name for name in SETTINGS)}
    with tarfile.open(archive_path, mode='r:gz') as archive:
        members = archive.getmembers()
        require(len(members) == len(allowed) and {m.name for m in members} == allowed
                and all(m.isfile() for m in members), 'BACKUP_INVALID')
        check_archive_sizes([m.size for m in members])
        (target / 'settings').mkdir(mode=0o700)
        for member in members:
            destination = target / member.name
            with archive.extractfile(member) as source, open(destination, 'xb') as out:
                shutil.copyfileobj(source, out)
            os.chmod(destination, 0o600)
    manifest = json.loads((target / 'manifest.json').read_text('utf-8'))
    require(manifest.get('formatVersion') == 1 and isinstance(manifest.get('files'), dict)
            and set(manifest['files']) == allowed - {'manifest.json'}, 'BACKUP_INVALID')
    for name, description in manifest['files'].items():
        path = target / name
        require(description == {'bytes': path.stat().st_size, 'sha256': digest(path)}, 'BACKUP_CHECKSUM_MISMATCH')
    schema_status(manifest.get('schema'), known_schema())
    return manifest


def restore_drill(stack, backup_path, expected_hash, identity_path):
    backup_path = Path(backup_path).absolute()
    private_directory(backup_path.parent)
    require(backup_path.is_file() and not backup_path.is_symlink()
            and backup_path.stat().st_uid == os.geteuid()
            and not stat.S_IMODE(backup_path.stat().st_mode) & 0o077, 'PRIVATE_BACKUP_REQUIRED')
    require(re.fullmatch(r'[0-9a-f]{64}', expected_hash or '') and digest(backup_path) == expected_hash, 'BACKUP_CHECKSUM_MISMATCH')
    identity_path = Path(identity_path).absolute()
    require(identity_path.is_file() and not identity_path.is_symlink()
            and identity_path.stat().st_uid == os.geteuid()
            and not stat.S_IMODE(identity_path.stat().st_mode) & 0o077, 'PRIVATE_AGE_IDENTITY_REQUIRED')
    require(shutil.which('age'), 'AGE_REQUIRED')
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='paperquay-restore-', dir=stack.directory) as temporary:
        stage = Path(temporary)
        os.chmod(stage, 0o700)
        with open(stage / 'archive.tar.gz', 'xb') as archive:
            run(['age', '-d', '-i', str(identity_path), str(backup_path)], stdout=archive)
        manifest = unpack(stage / 'archive.tar.gz', stage)
        image = manifest['images']['database']
        require(PIN.fullmatch(image), 'IMAGE_DIGEST_REQUIRED')
        # All archive validation precedes creating a container or volume.
        label = secrets.token_hex(12)
        name = stack.project + '-drill-' + label
        password = stage / 'bootstrap-password'
        password.write_text(secrets.token_urlsafe(48), 'utf-8')
        # The official image changes to its postgres UID before reading this
        # file. Its private parent is 0700 and it is mounted only in this clone.
        os.chmod(password, 0o444)
        run(['docker', 'volume', 'create', '--label', 'paperquay.drill=' + label, name], stdout=subprocess.DEVNULL)
        created_volume = json.loads(capture(['docker', 'volume', 'inspect', name]))[0]
        require(created_volume['Labels'].get('paperquay.drill') == label, 'CLONE_SCOPE_MISMATCH')
        run(['docker', 'run', '--detach', '--name', name, '--label', 'paperquay.drill=' + label,
             '--network', 'none', '--security-opt', 'no-new-privileges:true', '--memory', '768m',
             '--mount', 'type=volume,source=' + name + ',target=/var/lib/postgresql',
             '--mount', 'type=bind,source=' + str(password) + ',target=/run/secrets/bootstrap,readonly',
             '-e', 'POSTGRES_USER=paperquay_restore_bootstrap', '-e', 'POSTGRES_DB=postgres',
             '-e', 'POSTGRES_PASSWORD_FILE=/run/secrets/bootstrap', image],
            stdout=subprocess.DEVNULL)
        # Failure intentionally retains the labelled, network-isolated clone for
        # diagnosis. No command below references a source database volume.
        for _ in range(90):
            ready = subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', 'paperquay_restore_bootstrap'],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(1)
        else:
            raise OpsError('RESTORE_DATABASE_NOT_READY')
        with open(stage / 'cluster.sql', 'rb') as sql:
            run(['docker', 'exec', '-i', name, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U',
                 'paperquay_restore_bootstrap', '-d', 'template1'], stdin=sql, stdout=subprocess.DEVNULL)
        require(current_schema(name) == manifest['schema'], 'RESTORE_SCHEMA_MISMATCH')
        require(fingerprints(name) == manifest['fingerprints'], 'RESTORE_DATA_MISMATCH')
        result = {'status': 'restored_and_verified', 'sha256': expected_hash, 'quiescedAt': manifest['quiescedAt'],
                  'completedAt': utc(), 'restoreSeconds': round(time.monotonic() - started, 3),
                  'schema': schema_status(manifest['schema'], known_schema()), 'clone': name}
        # Only the fresh labelled drill is removed after a successful full hash
        # comparison. The encrypted backup and the source stack remain intact.
        metadata = json.loads(capture(['docker', 'inspect', name]))[0]
        volume = json.loads(capture(['docker', 'volume', 'inspect', name]))[0]
        require(metadata['Config']['Labels'].get('paperquay.drill') == label
                and volume['Labels'].get('paperquay.drill') == label, 'CLONE_SCOPE_MISMATCH')
        run(['docker', 'rm', '--force', name], stdout=subprocess.DEVNULL)
        run(['docker', 'volume', 'rm', name], stdout=subprocess.DEVNULL)
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    commands = parser.add_subparsers(dest='action', required=True)
    commands.add_parser('check')
    save = commands.add_parser('backup')
    save.add_argument('--output', required=True)
    save.add_argument('--recipient', required=True)
    restore = commands.add_parser('restore-drill')
    restore.add_argument('--backup', required=True)
    restore.add_argument('--expected-sha256', required=True)
    restore.add_argument('--identity', required=True)
    args = parser.parse_args()
    require(os.name == 'posix', 'LINUX_OPERATOR_REQUIRED')
    os.umask(0o077)
    stack = Stack(args.directory)
    with operation_lock(stack.directory):
        if args.action == 'check':
            database, _ = stack.container('database')
            result = {'status': 'checked', 'schema': schema_status(current_schema(database), known_schema()),
                      'services': {service: {'running': stack.container(service)[1]['State']['Running']} for service in SERVICES}}
        elif args.action == 'backup':
            result = backup(stack, args.output, args.recipient)
        else:
            result = restore_drill(stack, args.backup, args.expected_sha256, args.identity)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(json.dumps({'status': 'failed', 'code': str(error) if isinstance(error, OpsError) else 'OPERATION_FAILED'}))
        sys.exit(1)
