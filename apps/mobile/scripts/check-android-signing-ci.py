"""Exercise the release verifier with a disposable CI signing key, never production keys."""
import argparse
import copy
import hashlib
import json
import os
from pathlib import Path
import runpy
import re
import secrets
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
from zipfile import ZipFile


def run(args):
    result = subprocess.run([str(a) for a in args], capture_output=True, timeout=120)
    if result.returncode:
        # All inputs here belong to the disposable synthetic signer, so SDK
        # diagnostics can identify a tooling failure without logging passwords.
        raise RuntimeError('CI_SIGNING_SDK_COMMAND_FAILED: ' +
                           result.stderr.decode('utf-8', 'replace')[-2000:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('apk', 'debug-apk', 'settings', 'association', 'web-bundle', 'build-tools', 'java'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--version-code', type=int, required=True)
    parser.add_argument('--version-name', required=True)
    options = parser.parse_args()
    verifier = runpy.run_path(str(Path(__file__).with_name('verify-android-release.py')))
    with tempfile.TemporaryDirectory(prefix='paperquay-ci-signer-') as temporary:
        folder = Path(temporary).resolve(strict=True)
        assert folder.parent == Path(tempfile.gettempdir()).resolve(strict=True) and not folder.is_symlink()
        password = folder / 'password.txt'
        descriptor = os.open(password, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write(secrets.token_urlsafe(48))
        suffix = '.exe' if os.name == 'nt' else ''
        keytool = options.java.parent / ('keytool' + suffix)
        keystore = folder / 'ci.p12'
        run([keytool, '-genkeypair', '-keystore', keystore, '-storetype', 'PKCS12',
             '-storepass:file', password, '-keypass:file', password, '-alias', 'paperquay-ci',
             '-keyalg', 'RSA', '-keysize', '2048', '-validity', '2', '-dname', 'CN=PaperQuay CI'])
        certificate = folder / 'certificate.der'
        run([keytool, '-exportcert', '-keystore', keystore, '-storepass:file', password,
             '-alias', 'paperquay-ci', '-file', certificate])
        value = hashlib.sha256(certificate.read_bytes()).hexdigest().upper()
        fingerprint = ':'.join(value[i:i + 2] for i in range(0, 64, 2))
        association = json.loads(options.association.read_text('utf-8'))
        association[0]['target']['sha256_cert_fingerprints'] = [fingerprint]
        expected = folder / 'assetlinks.json'
        expected.write_text(json.dumps(association), 'utf-8')
        signed = folder / 'signed.apk'
        # PKCS12 uses the store password for this key. Supplying the same
        # password file twice makes apksigner consume a second, absent line.
        run([options.java, '-jar', options.build_tools / 'lib/apksigner.jar', 'sign',
             '--ks', keystore, '--ks-key-alias', 'paperquay-ci', '--ks-pass', 'file:' + str(password),
             '--v4-signing-enabled', 'false',
             '--out', signed, options.apk])
        args = SimpleNamespace(**vars(options)); args.apk = signed; args.association = expected
        positive = verifier['verify'](args)
        assert positive['status'] == 'SIGNED_ANDROID_PACKAGE_VERIFIED'
        cases = []
        def reject(label, changed, code):
            try:
                verifier['verify'](changed)
            except verifier['VerificationError'] as error:
                assert str(error) == code, label
                cases.append(label)
            else:
                raise AssertionError(label)
        bad = copy.copy(args); bad.apk = options.apk
        reject('unsigned APK', bad, 'ANDROID_SDK_VERIFICATION_FAILED')
        bad = copy.copy(args); bad.association = options.association
        reject('different association certificate', bad, 'ANDROID_SIGNER_ASSOCIATION_MISMATCH')
        bad = copy.copy(args); bad.version_code += 1
        reject('wrong version', bad, 'ANDROID_PACKAGE_VERSION_INVALID')
        debug_info = verifier['tool']([options.java, '-jar', options.build_tools / 'lib/apksigner.jar',
                                       'verify', '--verbose', '--print-certs', options.debug_apk])
        debug_digest = re.search(r'^Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$',
                                 debug_info, re.MULTILINE)
        assert debug_digest, 'DEBUG_CERTIFICATE_METADATA_REQUIRED'
        value = debug_digest[1].upper()
        debug_association = copy.deepcopy(association)
        debug_association[0]['target']['sha256_cert_fingerprints'] = [
            ':'.join(value[i:i + 2] for i in range(0, 64, 2))]
        debug_expected = folder / 'debug-assetlinks.json'
        debug_expected.write_text(json.dumps(debug_association), 'utf-8')
        bad = copy.copy(args); bad.apk = options.debug_apk; bad.association = debug_expected
        reject('debug signing certificate', bad, 'ANDROID_DEBUG_SIGNER_REJECTED')
        bad = copy.copy(args); bad.apk = folder / 'tampered.apk'
        shutil.copyfile(signed, bad.apk)
        with ZipFile(bad.apk, 'a') as archive:
            archive.writestr('assets/public/unapproved.html', 'synthetic tamper')
        reject('APK modified after signing', bad, 'ANDROID_SDK_VERIFICATION_FAILED')
        print(json.dumps({'status': 'DISPOSABLE_CI_SIGNING_CHECK_PASSED',
                          'signedPackageVerified': True, 'negativeCasesRejected': cases,
                          'productionSigningIdentityUsed': False,
                          'osAssociationOrLoginChecked': False}))


if __name__ == '__main__':
    main()
