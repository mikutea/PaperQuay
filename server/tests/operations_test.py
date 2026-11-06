"""Recovery input and service-state boundaries; no production access."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('paperquay_ops', Path(__file__).resolve().parents[1] / 'deploy/ops.py')
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='paperquay-ops-test-')
        self.directory = Path(self.temporary.name).resolve()
        # Cleanup is confined to this newly created system-temporary directory.
        self.assertEqual(self.directory.parent, Path(tempfile.gettempdir()).resolve())
        self.addCleanup(self.temporary.cleanup)

    def archive(self, change=None, extra=None):
        source = self.directory / 'source'
        source.mkdir()
        (source / 'settings').mkdir()
        files = ['cluster.sql', 'images.tar', *('settings/' + name for name in ops.SETTINGS)]
        for name in files:
            (source / name).write_text('synthetic-content:' + name, 'utf-8')
        manifest = {'formatVersion': 1, 'schema': ops.known_schema(),
                    'files': {name: {'bytes': (source / name).stat().st_size, 'sha256': ops.digest(source / name)} for name in files}}
        if change:
            change(manifest, source)
        (source / 'manifest.json').write_text(json.dumps(manifest), 'utf-8')
        output = self.directory / 'fixture.tar.gz'
        with tarfile.open(output, 'w:gz') as archive:
            for name in ('manifest.json', *files):
                archive.add(source / name, arcname=name, recursive=False)
            if extra:
                archive.addfile(*extra)
        target = self.directory / 'restored'
        target.mkdir()
        return output, target

    def test_schema_requires_an_exact_known_prefix(self):
        known = ops.known_schema()
        self.assertEqual(ops.schema_status(known, known), 'compatible')
        self.assertEqual(ops.schema_status(known[:-1], known), 'upgrade_required')
        for wrong in [known[1:], known + [{'version': '999_future.sql', 'checksum': '0' * 64}],
                      [dict(known[0], checksum='0' * 64), *known[1:]], None]:
            with self.assertRaisesRegex(ops.OpsError, 'SCHEMA_UNSUPPORTED'):
                ops.schema_status(wrong, known)

    def test_full_archive_checks_all_files_including_images_and_configuration(self):
        archive, target = self.archive()
        manifest = ops.unpack(archive, target)
        self.assertEqual(len(manifest['files']), len(ops.SETTINGS) + 2)
        self.assertEqual((target / 'settings/sync.env').read_text('utf-8'), 'synthetic-content:settings/sync.env')

    def test_corrupted_content_is_rejected(self):
        archive, target = self.archive(lambda _manifest, source: (source / 'cluster.sql').write_text('tampered'))
        with self.assertRaisesRegex(ops.OpsError, 'BACKUP_CHECKSUM_MISMATCH'):
            ops.unpack(archive, target)

    def test_complete_payload_limit_includes_manifest_and_all_settings(self):
        archive, target = self.archive()
        with tarfile.open(archive) as source:
            total = sum(member.size for member in source.getmembers())
        with patch.object(ops, 'MAX_ARCHIVE_BYTES', total - 1):
            with self.assertRaisesRegex(ops.OpsError, 'BACKUP_INVALID'):
                ops.unpack(archive, target)
        self.assertEqual(list(target.iterdir()), [])
        with patch.object(ops, 'MAX_ARCHIVE_BYTES', total):
            ops.unpack(archive, target)
        self.assertTrue((target / 'cluster.sql').is_file())

    def test_oversized_backup_is_rejected_before_encryption_or_publication(self):
        settings = self.directory / 'operator'
        settings.mkdir()
        for name in ops.SETTINGS:
            (settings / name).write_text('synthetic-settings', 'utf-8')

        class Stack:
            directory = settings
            project = 'paperquay-synthetic'

            def container(self, service):
                return 'fixture-' + service, {'Image': 'sha256:' + 'a' * 64}

        def capture(args):
            if 'pg_database WHERE NOT datistemplate' in args[-1]:
                return json.dumps(sorted(['postgres', *ops.DATABASES]))
            if args[1:3] == ['image', 'inspect']:
                return '[{"Size": 1}]'
            return '1'

        def run(args, **kwargs):
            if 'pg_dumpall' in args:
                kwargs['stdout'].write(b'-- synthetic cluster')
            elif args[1:3] == ['image', 'save']:
                Path(args[args.index('--output') + 1]).write_bytes(b'synthetic images')
            else:
                raise AssertionError('Unexpected external operation')

        output = self.directory / 'oversized.age'
        with contextlib.ExitStack() as scope:
            scope.enter_context(patch.object(ops, 'private_directory', return_value=self.directory))
            scope.enter_context(patch.object(ops.shutil, 'which', return_value='synthetic-age'))
            scope.enter_context(patch.object(ops.shutil, 'disk_usage', return_value=SimpleNamespace(free=10**15)))
            scope.enter_context(patch.object(ops, 'capture', side_effect=capture))
            scope.enter_context(patch.object(ops, 'run', side_effect=run))
            scope.enter_context(patch.object(ops, 'quiesce', return_value=contextlib.nullcontext()))
            scope.enter_context(patch.object(ops, 'current_schema', return_value=ops.known_schema()))
            scope.enter_context(patch.object(ops, 'fingerprints', return_value={'synthetic': True}))
            scope.enter_context(patch.object(ops, 'MAX_ARCHIVE_BYTES', 128))
            encrypt = scope.enter_context(patch.object(ops.subprocess, 'Popen'))
            with self.assertRaisesRegex(ops.OpsError, 'BACKUP_TOO_LARGE'):
                ops.backup(Stack(), output, 'age1' + 'a' * 58)
            encrypt.assert_not_called()
        self.assertFalse(output.exists())
        self.assertFalse(output.with_name(output.name + '.partial').exists())
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ['operator'])

    def test_future_backup_is_rejected_before_docker_runs(self):
        archive, target = self.archive(lambda manifest, _source: manifest['schema'].append(
            {'version': '999_future.sql', 'checksum': '0' * 64}))
        with patch.object(ops, 'run') as run:
            with self.assertRaisesRegex(ops.OpsError, 'SCHEMA_UNSUPPORTED'):
                ops.unpack(archive, target)
            run.assert_not_called()

    def test_archive_cannot_write_extra_paths_or_symlinks(self):
        entry = tarfile.TarInfo('../outside-sentinel')
        entry.size = 4
        archive, target = self.archive(extra=(entry, io.BytesIO(b'test')))
        with self.assertRaisesRegex(ops.OpsError, 'BACKUP_INVALID'):
            ops.unpack(archive, target)
        self.assertFalse((self.directory / 'outside-sentinel').exists())
        self.assertEqual(list(target.iterdir()), [])

    def test_symbolic_link_is_rejected(self):
        archive, target = self.archive()
        replacement = self.directory / 'linked.tar.gz'
        with tarfile.open(archive) as original, tarfile.open(replacement, 'w:gz') as changed:
            for member in original.getmembers():
                if member.name == 'cluster.sql':
                    member.type = tarfile.SYMTYPE
                    member.linkname = '/etc/passwd'
                    member.size = 0
                    changed.addfile(member)
                else:
                    changed.addfile(member, original.extractfile(member))
        with self.assertRaisesRegex(ops.OpsError, 'BACKUP_INVALID'):
            ops.unpack(replacement, target)
        self.assertEqual(list(target.iterdir()), [])

    def test_failed_backup_only_restarts_services_that_were_running(self):
        class Stack:
            state = {'sync': True, 'identity': False}

            def container(self, service):
                return service, {'State': {'Running': self.state[service]}}

            def command(self, *args):
                return list(args)

        stack = Stack()
        calls = []

        def execute(args, **_kwargs):
            calls.append(args)
            if args[0] == 'stop':
                stack.state['sync'] = False
            if args[0] == 'start':
                stack.state['sync'] = True

        with patch.object(ops, 'run', side_effect=execute):
            with self.assertRaisesRegex(RuntimeError, 'synthetic dump failure'):
                with ops.quiesce(stack):
                    self.assertEqual(stack.state, {'sync': False, 'identity': False})
                    raise RuntimeError('synthetic dump failure')
        self.assertEqual(calls, [['stop', '--timeout', '60', 'sync'], ['start', 'sync']])
        self.assertEqual(stack.state, {'sync': True, 'identity': False})

    def test_mutable_image_tags_and_shell_expansion_are_not_accepted(self):
        self.assertIsNotNone(ops.PIN.fullmatch('postgres@sha256:' + 'a' * 64))
        for image in ('postgres:18.6', 'latest', 'sha256:bad', 'image@sha256:' + 'g' * 64):
            self.assertIsNone(ops.PIN.fullmatch(image))
        path = self.directory / 'compose.env'
        for text in ('A=$(secret-command)', 'A=value\nA=other', 'A="quoted"', 'export A=value'):
            path.write_text(text, 'utf-8')
            with self.assertRaises(ops.OpsError):
                ops.read_env(path)

    def test_proxy_scope_requires_fixed_private_web_and_exact_ingress_peers(self):
        env = {'PAPERQUAY_APPLICATION_SUBNET': '172.30.71.0/24',
               'PAPERQUAY_WEB_IP': '172.30.71.2', 'PAPERQUAY_INGRESS_PROXY_IPS': '172.30.71.1 127.0.0.1'}
        self.assertEqual(ops.proxy_addresses(env), '172.30.71.2')
        for change in ({'PAPERQUAY_WEB_IP': '172.30.71.1'}, {'PAPERQUAY_WEB_IP': '172.30.71.0'},
                       {'PAPERQUAY_WEB_IP': '172.30.71.255'}, {'PAPERQUAY_WEB_IP': '172.30.72.2'},
                       {'PAPERQUAY_APPLICATION_SUBNET': '0.0.0.0/0'},
                       {'PAPERQUAY_APPLICATION_SUBNET': '127.0.0.0/24', 'PAPERQUAY_WEB_IP': '127.0.0.2'},
                       {'PAPERQUAY_INGRESS_PROXY_IPS': 'private_ranges'},
                       {'PAPERQUAY_INGRESS_PROXY_IPS': '172.30.71.0/24'},
                       {'PAPERQUAY_INGRESS_PROXY_IPS': '0.0.0.0'}, {'PAPERQUAY_INGRESS_PROXY_IPS': ''}):
            with self.assertRaisesRegex(ops.OpsError, 'PROXY_SCOPE_INVALID'):
                ops.proxy_addresses({**env, **change})


if __name__ == '__main__':
    unittest.main()
