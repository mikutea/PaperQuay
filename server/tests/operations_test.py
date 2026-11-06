"""Recovery input and service-state boundaries; no production access."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
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


if __name__ == '__main__':
    unittest.main()
