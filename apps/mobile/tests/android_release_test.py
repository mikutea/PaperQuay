import io
import json
from pathlib import Path
import runpy
import stat
import tempfile
import unittest
import warnings
from zipfile import ZipFile, ZipInfo

v = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/verify-android-release.py'))
ORIGIN = 'https://links.example.test'
CERT = ':'.join(['AB'] * 32)
NS = 'http://schemas.android.com/apk/res/android:'


def settings():
    return {'formatVersion': 1, 'platform': 'android', 'origin': ORIGIN,
            'apiBaseUrl': 'https://sync.example.test/api',
            'oidcAuthority': 'https://id.example.test/realms/paperquay'}


def association():
    return [{'relation': ['delegate_permission/common.handle_all_urls'], 'target': {
        'namespace': 'android_app', 'package_name': v['APP_ID'],
        'sha256_cert_fingerprints': [CERT]}}]


def manifest():
    return f'''N: android=http://schemas.android.com/apk/res/android (line=2)
  E: manifest (line=2)
    A: package="dev.paperquay.mobile" (Raw: "dev.paperquay.mobile")
      E: application (line=10)
        A: {NS}allowBackup(0x01010280)=false
        A: {NS}usesCleartextTraffic(0x010104ec)=false
          E: activity (line=20)
            A: {NS}name(0x01010003)="dev.paperquay.mobile.MainActivity"
            A: {NS}exported(0x01010010)=true
              E: intent-filter (line=30)
                A: {NS}autoVerify(0x010104ee)=true
                  E: action (line=31)
                    A: {NS}name(0x01010003)="android.intent.action.VIEW"
                  E: category (line=32)
                    A: {NS}name(0x01010003)="android.intent.category.DEFAULT"
                  E: category (line=33)
                    A: {NS}name(0x01010003)="android.intent.category.BROWSABLE"
                  E: data (line=34)
                    A: {NS}scheme(0x01010027)="https"
                    A: {NS}host(0x01010028)="links.example.test"
                    A: {NS}path(0x0101002a)="/auth/native/android/callback"
                  E: data (line=35)
                    A: {NS}scheme(0x01010027)="https"
                    A: {NS}host(0x01010028)="links.example.test"
                    A: {NS}path(0x0101002a)="/auth/native/android/logout"
'''


class AndroidReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='paperquay-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.web = self.root / 'web'
        self.web.mkdir()
        (self.web / 'index.html').write_text('<script src="app.js"></script>', 'utf-8')
        (self.web / 'app.js').write_text('console.log("synthetic")', 'utf-8')
        binding = {'formatVersion': 1, 'platform': 'android', 'origin': ORIGIN,
                   'clientId': 'paperquay-android',
                   'redirectUri': ORIGIN + '/auth/native/android/callback',
                   'logoutRedirectUri': ORIGIN + '/auth/native/android/logout',
                   'files': {p.name: v['file_hash'](p) for p in self.web.iterdir()}}
        (self.web / 'native-link-binding.json').write_text(json.dumps(binding), 'utf-8')
        (self.web / 'capacitor.js').write_text('/* synthetic bridge */', 'utf-8')

    def rejected(self, code, function, *args):
        with self.assertRaisesRegex(v['VerificationError'], '^' + code + '$'):
            function(*args)

    def archive(self, extra=None, altered=False):
        path = self.root / 'package.apk'
        config = {'appId': v['APP_ID'], 'android': {
            'webContentsDebuggingEnabled': False, 'allowMixedContent': False}}
        with ZipFile(path, 'w') as archive:
            for p in self.web.iterdir():
                body = p.read_bytes() if not (altered and p.name == 'app.js') else b'changed'
                archive.writestr('assets/public/' + p.name, body)
            archive.writestr('assets/capacitor.config.json', json.dumps(config))
            if extra:
                entry = ZipInfo('placeholder')
                entry.filename = extra
                entry.orig_filename = extra
                archive.writestr(entry, 'extra')
        return path

    def test_actual_sdk_manifest_shape_requires_exact_platform_routes(self):
        v['verify_manifest'](manifest(), 'links.example.test')
        for altered in [manifest().replace('links.example.test', 'wrong.example.test'),
                        manifest().replace('/android/logout', '/ios/logout'),
                        manifest().replace('exported(0x01010010)=true', 'exported(0x01010010)=false'),
                        manifest().replace('autoVerify(0x010104ee)=true', 'autoVerify(0x010104ee)=false'),
                        manifest().replace(NS + 'path(', NS + 'pathPrefix(')]:
            self.rejected('ANDROID_CALLBACK_MANIFEST_INVALID', v['verify_manifest'],
                          altered, 'links.example.test')

    def test_other_xml_namespace_cannot_supply_security_attributes(self):
        self.rejected('ANDROID_RELEASE_CONFIGURATION_INVALID', v['verify_manifest'],
                      manifest().replace(NS + 'allowBackup', 'https://other.example.test:allowBackup'),
                      'links.example.test')

    def test_release_rejects_debugging_backups_and_cleartext(self):
        for altered in [manifest().replace('allowBackup(0x01010280)=false', 'allowBackup(0x01010280)=true'),
                        manifest().replace('usesCleartextTraffic(0x010104ec)=false', 'usesCleartextTraffic(0x010104ec)=true'),
                        manifest().replace('      E: application (line=10)',
                                           '      E: application (line=10)\n        A: ' + NS + 'debuggable(0x0101000f)=true')]:
            self.rejected('ANDROID_RELEASE_CONFIGURATION_INVALID', v['verify_manifest'],
                          altered, 'links.example.test')

    def test_signature_metadata_requires_expected_non_debug_single_signer(self):
        valid = ('Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\n'
                 'Signer #1 certificate DN: CN=PaperQuay CI\n'
                 'Signer #1 certificate SHA-256 digest: ' + CERT.replace(':', '').lower() + '\n')
        self.assertEqual(v['signer_fingerprint'](valid, {CERT}), CERT)
        self.rejected('ANDROID_SIGNER_ASSOCIATION_MISMATCH', v['signer_fingerprint'],
                      valid, {':'.join(['CD'] * 32)})
        self.rejected('ANDROID_DEBUG_SIGNER_REJECTED', v['signer_fingerprint'],
                      valid.replace('CN=PaperQuay CI', 'CN=Android Debug, O=Android, C=US'), {CERT})
        self.rejected('ANDROID_SIGNATURE_INVALID', v['signer_fingerprint'],
                      valid.replace('v2): true', 'v2): false'), {CERT})
        self.rejected('ANDROID_SIGNATURE_INVALID', v['signer_fingerprint'],
                      valid + 'Signer #2 certificate SHA-256 digest: ' + CERT.replace(':', '') + '\n', {CERT})

    def test_association_rejects_other_apps_and_invalid_or_duplicate_certificates(self):
        self.assertEqual(v['expected_certificates'](association()), {CERT})
        bad = association(); bad[0]['target']['package_name'] = 'dev.other.app'
        self.rejected('ANDROID_ASSOCIATION_INVALID', v['expected_certificates'], bad)
        for certificates in [[CERT, CERT], [CERT.lower()], [':'.join(['00'] * 32)], []]:
            bad = association(); bad[0]['target']['sha256_cert_fingerprints'] = certificates
            self.rejected('ANDROID_ASSOCIATION_INVALID', v['expected_certificates'], bad)

    def test_operator_inputs_are_outside_git_and_duplicate_json_is_rejected(self):
        self.rejected('ANDROID_JSON_INVALID', v['document'], b'{"origin":"one","origin":"two"}')
        folder = self.root / 'repository'; folder.mkdir(); (folder / '.git').write_text('gitdir: other')
        path = folder / 'native.json'; path.write_text(json.dumps(settings()))
        self.rejected('ANDROID_OPERATOR_SETTINGS_OUTSIDE_GIT_REQUIRED', v['operator_document'], path)

    def test_origin_requires_canonical_https_host_and_android_configuration(self):
        self.assertEqual(v['checked_origin'](settings()), (ORIGIN, 'links.example.test'))
        for origin in ['http://links.example.test', ORIGIN + '/', ORIGIN + ':443',
                       'https://user:password@links.example.test', 'https://unconfigured.invalid']:
            bad = settings(); bad['origin'] = origin
            self.rejected('ANDROID_ORIGIN_INVALID', v['checked_origin'], bad)
        bad = settings(); bad['platform'] = 'ios'
        self.rejected('ANDROID_OPERATOR_SETTINGS_INVALID', v['checked_origin'], bad)

    def test_copied_web_binding_and_complete_packaged_web_bytes_must_match(self):
        expected = v['expected_web'](self.web, ORIGIN)
        self.assertEqual(len(expected), 4)
        v['verify_archive'](self.archive(), expected)
        self.rejected('ANDROID_PACKAGED_WEB_BYTES_CHANGED', v['verify_archive'],
                      self.archive(altered=True), expected)
        self.rejected('ANDROID_PACKAGED_WEB_BYTES_CHANGED', v['verify_archive'],
                      self.archive(extra='assets/public/extra.html'), expected)
        (self.web / 'app.js').write_text('changed')
        self.rejected('ANDROID_WEB_BINDING_BYTES_CHANGED', v['expected_web'], self.web, ORIGIN)

    def test_archive_rejects_traversal_duplicate_entries_and_links(self):
        expected = v['expected_web'](self.web, ORIGIN)
        for name in ['../outside', 'assets\\public\\other', 'assets/public/../other', 'assets//other']:
            self.rejected('ANDROID_APK_ARCHIVE_INVALID', v['verify_archive'],
                          self.archive(extra=name), expected)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore')
            self.rejected('ANDROID_APK_ARCHIVE_INVALID', v['verify_archive'],
                          self.archive(extra='assets/public/app.js'), expected)
        path = self.archive()
        with ZipFile(path, 'a') as archive:
            entry = ZipInfo('assets/link'); entry.create_system = 3
            entry.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(entry, '/outside')
        self.rejected('ANDROID_APK_ARCHIVE_INVALID', v['verify_archive'], path, expected)

    def test_bounded_reader_stops_oversize_input(self):
        self.rejected('ANDROID_INPUT_TOO_LARGE', v['digest'], io.BytesIO(b'123456789'), 8)


if __name__ == '__main__':
    unittest.main()
