import hashlib
import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('artifact_cache', Path(__file__).parents[1] / 'cache-ios-artifacts.py')
cache = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cache)


class FakeChild:
    def __init__(self, data, code=0):
        self.stdout = io.BytesIO(data)
        self.code = code

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.stdout.close()

    def wait(self):
        return self.code

    def poll(self):
        return self.code

    def kill(self):
        self.code = -1


class ArtifactCacheTests(unittest.TestCase):
    def setUp(self):
        self.data = b'checksum-pinned binary fixture'
        self.name = 'Capacitor.xcframework.zip'
        self.expected = {self.name: hashlib.sha256(self.data).hexdigest()}
        self.asset = {'id': 1, 'size': len(self.data), 'name': self.name,
                      'digest': 'sha256:' + self.expected[self.name], 'state': 'uploaded'}
        self.release = {'tag_name': '8.5.3', 'draft': False, 'assets': [self.asset]}
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)

    def download(self, asset=None):
        return cache.download('gh', 'ionic-team/capacitor-swift-pm', '8.5.3', self.expected,
                              asset or self.asset, self.directory, {})

    def test_upstream_url_cache_key(self):
        self.assertEqual(cache.cache_key('ionic-team/capacitor-swift-pm', '8.5.3', self.name),
                         'https___github_com_ionic_team_capacitor_swift_pm_releases_download_8_5_3_Capacitor_xcframework_zip')

    def test_metadata_rejects_changed_checksum_duplicate_and_bad_shape(self):
        self.assertEqual(cache.validate_release(self.release, '8.5.3', self.expected), [self.asset])
        invalid = [None, {}, {**self.release, 'draft': True}, {**self.release, 'assets': [None]},
                   {**self.release, 'assets': [self.asset, self.asset]}]
        for field, value in [('size', 0), ('size', cache.MAX_BYTES + 1), ('id', True),
                             ('digest', 'sha256:' + '0' * 64), ('state', 'new')]:
            invalid.append({**self.release, 'assets': [{**self.asset, field: value}]})
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(cache.ArtifactError):
                cache.validate_release(value, '8.5.3', self.expected)

    def test_verified_download_and_cache_reuse(self):
        with patch.object(cache.subprocess, 'Popen', return_value=FakeChild(self.data)) as process:
            self.assertFalse(self.download()['reused'])
            self.assertTrue(self.download()['reused'])
            self.assertEqual(process.call_count, 1)

    def test_corrupt_existing_cache_never_downloads_or_replaces(self):
        destination = self.directory / cache.cache_key('ionic-team/capacitor-swift-pm', '8.5.3', self.name)
        destination.write_bytes(b'corrupt')
        with patch.object(cache.subprocess, 'Popen') as process, self.assertRaisesRegex(cache.ArtifactError, 'EXISTING_CACHE'):
            self.download()
        process.assert_not_called()
        self.assertEqual(destination.read_bytes(), b'corrupt')

    def test_partial_download_is_retained_and_cannot_be_retried_blindly(self):
        with patch.object(cache.subprocess, 'Popen', return_value=FakeChild(b'bad')):
            with self.assertRaisesRegex(cache.ArtifactError, 'CHECKSUM'):
                self.download()
        self.assertEqual(len(list(self.directory.glob('*.download'))), 1)
        with patch.object(cache.subprocess, 'Popen') as process, self.assertRaisesRegex(cache.ArtifactError, 'RETAINED_PARTIAL'):
            self.download()
        process.assert_not_called()

    def test_oversized_or_failed_download_is_not_promoted(self):
        for data, code, error in [(self.data + b'overflow', 0, 'EXCEEDS'), (self.data, 1, 'DOWNLOAD_FAILED')]:
            with self.subTest(error=error), tempfile.TemporaryDirectory() as directory:
                self.directory = Path(directory)
                with patch.object(cache.subprocess, 'Popen', return_value=FakeChild(data, code)):
                    with self.assertRaisesRegex(cache.ArtifactError, error):
                        self.download()
                self.assertTrue(all(file.name.endswith('.download') for file in self.directory.iterdir()))


if __name__ == '__main__':
    unittest.main()
