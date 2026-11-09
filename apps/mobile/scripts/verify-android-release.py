"""Verify a signed APK against the operator's binding and copied web bundle.

Android SDK tools verify the cryptographic signature and decode the manifest.
No signing key, account token, network request or device is used by this tool.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import tempfile
from urllib.parse import urlsplit
from zipfile import ZipFile

APP_ID = 'dev.paperquay.mobile'
CLIENT_ID = 'paperquay-android'
ANDROID_NAMESPACE = 'http://schemas.android.com/apk/res/android:'
MAX_APK = 256 * 1024**2
MAX_FILE = 128 * 1024**2
MAX_EXPANDED = 512 * 1024**2
BRIDGES = {'capacitor.js', 'capacitor_plugins.js', 'cordova.js', 'cordova_plugins.js'}


class VerificationError(Exception):
    pass


def require(ok, code):
    if not ok:
        raise VerificationError(code)


def digest(stream, limit=MAX_FILE):
    checksum = hashlib.sha256()
    total = 0
    while block := stream.read(min(1024**2, limit - total + 1)):
        total += len(block)
        require(total <= limit, 'ANDROID_INPUT_TOO_LARGE')
        checksum.update(block)
    return checksum.hexdigest()


def file_hash(path, limit=MAX_APK):
    with path.open('rb') as stream:
        return digest(stream, limit)


def no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, 'ANDROID_JSON_INVALID')
        result[key] = value
    return result


def document(data):
    require(len(data) <= 1024**2, 'ANDROID_JSON_INVALID')
    try:
        return json.loads(data, object_pairs_hook=no_duplicates)
    except (ValueError, UnicodeError):
        raise VerificationError('ANDROID_JSON_INVALID') from None


def operator_document(path):
    absolute = path.absolute()
    for start in (absolute, absolute.resolve(strict=True)):
        require(not any((parent / '.git').exists() for parent in (start, *start.parents)),
                'ANDROID_OPERATOR_SETTINGS_OUTSIDE_GIT_REQUIRED')
    require(stat.S_ISREG(path.lstat().st_mode) and not path.is_symlink()
            and path.stat().st_size <= 16384, 'ANDROID_OPERATOR_SETTINGS_INVALID')
    return document(path.read_bytes())


def checked_origin(settings):
    require(isinstance(settings, dict) and set(settings) == {
        'formatVersion', 'platform', 'origin', 'apiBaseUrl', 'oidcAuthority'
    } and type(settings['formatVersion']) is int and settings['formatVersion'] == 1
            and settings['platform'] == 'android',
            'ANDROID_OPERATOR_SETTINGS_INVALID')
    origin = settings['origin']
    require(isinstance(origin, str) and len(origin) <= 2048, 'ANDROID_ORIGIN_INVALID')
    parsed = urlsplit(origin)
    host = parsed.hostname or ''
    require(parsed.scheme == 'https' and origin == 'https://' + host
            and host != 'unconfigured.invalid' and len(host) <= 253
            and re.fullmatch(r'(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]', host),
            'ANDROID_ORIGIN_INVALID')
    return origin, host


def expected_certificates(association):
    require(isinstance(association, list) and len(association) == 1,
            'ANDROID_ASSOCIATION_INVALID')
    row = association[0]
    require(isinstance(row, dict) and set(row) == {'relation', 'target'}
            and row['relation'] == ['delegate_permission/common.handle_all_urls'],
            'ANDROID_ASSOCIATION_INVALID')
    target = row['target']
    require(isinstance(target, dict) and set(target) == {
        'namespace', 'package_name', 'sha256_cert_fingerprints'
    } and target['namespace'] == 'android_app' and target['package_name'] == APP_ID,
            'ANDROID_ASSOCIATION_INVALID')
    values = target['sha256_cert_fingerprints']
    require(isinstance(values, list) and 1 <= len(values) <= 4
            and all(isinstance(v, str) and re.fullmatch(r'(?:[A-F0-9]{2}:){31}[A-F0-9]{2}', v)
                    and v != ':'.join(['00'] * 32) for v in values)
            and len(set(values)) == len(values), 'ANDROID_ASSOCIATION_INVALID')
    return set(values)


def safe_name(name):
    path = PurePosixPath(name)
    return bool(name) and not path.is_absolute() and path.as_posix() == name \
        and not any(part in ('.', '..') for part in path.parts) \
        and not re.search(r'[\\\x00-\x1f\x7f:]', name)


def expected_web(folder, origin):
    require(folder.is_dir() and not folder.is_symlink()
            and not getattr(folder, 'is_junction', lambda: False)(), 'ANDROID_WEB_BUNDLE_INVALID')
    files = {}
    total = 0
    for path in folder.rglob('*'):
        require(not path.is_symlink() and not getattr(path, 'is_junction', lambda: False)(),
                'ANDROID_WEB_BUNDLE_INVALID')
        if path.is_dir():
            continue
        name = path.relative_to(folder).as_posix()
        require(path.is_file() and safe_name(name) and path.stat().st_size <= MAX_FILE
                and len(files) < 4096, 'ANDROID_WEB_BUNDLE_INVALID')
        total += path.stat().st_size
        require(total <= MAX_EXPANDED, 'ANDROID_WEB_BUNDLE_INVALID')
        files[name] = file_hash(path, MAX_FILE)
    binding = document((folder / 'native-link-binding.json').read_bytes())
    require(isinstance(binding, dict) and set(binding) == {
        'formatVersion', 'platform', 'origin', 'clientId', 'redirectUri', 'logoutRedirectUri', 'files'
    } and type(binding['formatVersion']) is int and binding['formatVersion'] == 1
            and binding['platform'] == 'android'
            and binding['origin'] == origin and binding['clientId'] == CLIENT_ID
            and binding['redirectUri'] == origin + '/auth/native/android/callback'
            and binding['logoutRedirectUri'] == origin + '/auth/native/android/logout',
            'ANDROID_WEB_BINDING_INVALID')
    declared = binding['files']
    require(isinstance(declared, dict) and 1 < len(declared) <= 4096
            and 'index.html' in declared and any(n.endswith(('.js', '.mjs')) for n in declared)
            and all(safe_name(n) and isinstance(h, str) and re.fullmatch('[a-f0-9]{64}', h)
                    for n, h in declared.items()), 'ANDROID_WEB_BINDING_INVALID')
    actual = {n: h for n, h in files.items() if n != 'native-link-binding.json'
              and (n not in BRIDGES or n in declared)}
    require(actual == declared, 'ANDROID_WEB_BINDING_BYTES_CHANGED')
    return files


def tool(args):
    try:
        result = subprocess.run([str(a) for a in args], capture_output=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired):
        raise VerificationError('ANDROID_SDK_TOOL_FAILED') from None
    require(result.returncode == 0 and len(result.stdout) + len(result.stderr) <= 4 * 1024**2,
            'ANDROID_SDK_VERIFICATION_FAILED')
    return result.stdout.decode('utf-8', 'strict')


def signer_fingerprint(output, certificates):
    rows = re.findall(r'^Signer #(\d+) certificate SHA-256 digest: ([a-fA-F0-9]{64})\s*$',
                      output, re.MULTILINE)
    require(len(rows) == 1 and rows[0][0] == '1'
            and re.search(r'^Verified using v2 scheme .*: true\s*$', output, re.MULTILINE),
            'ANDROID_SIGNATURE_INVALID')
    require(not re.search(r'^Signer #1 certificate DN:.*CN\s*=\s*Android Debug(?:,|\s*$)',
                          output, re.MULTILINE | re.IGNORECASE), 'ANDROID_DEBUG_SIGNER_REJECTED')
    value = rows[0][1].upper()
    fingerprint = ':'.join(value[i:i + 2] for i in range(0, 64, 2))
    require(fingerprint in certificates, 'ANDROID_SIGNER_ASSOCIATION_MISMATCH')
    return fingerprint


def manifest_tree(output):
    root = None
    stack = []
    for line in output.splitlines():
        match = re.match(r'^(\s*)E: ([\w.-]+)(?:\s|$)', line)
        if match:
            depth = len(match[1])
            node = {'tag': match[2], 'attrs': {}, 'children': []}
            while stack and stack[-1][0] >= depth:
                stack.pop()
            if stack:
                stack[-1][1]['children'].append(node)
            else:
                require(root is None, 'ANDROID_MANIFEST_INVALID')
                root = node
            stack.append((depth, node))
            continue
        match = re.match(r'^\s*A: (\S+?)(?:\(0x[a-fA-F0-9]+\))?=(.*)$', line)
        if match and stack:
            name, raw = match.groups()
            if name.startswith(ANDROID_NAMESPACE):
                name = 'android:' + name.removeprefix(ANDROID_NAMESPACE)
            require(name not in stack[-1][1]['attrs'], 'ANDROID_MANIFEST_INVALID')
            if raw.startswith('"'):
                try:
                    value, _ = json.JSONDecoder().raw_decode(raw)
                except ValueError:
                    raise VerificationError('ANDROID_MANIFEST_INVALID') from None
            elif raw in ('true', 'false'):
                value = raw == 'true'
            elif re.fullmatch(r'\(type 0x12\)0x(?:ffffffff|0)', raw):
                value = raw.endswith('ffffffff')
            else:
                value = raw
            stack[-1][1]['attrs'][name] = value
    require(root is not None and root['tag'] == 'manifest', 'ANDROID_MANIFEST_INVALID')
    return root


def verify_manifest(output, host):
    root = manifest_tree(output)
    applications = [n for n in root['children'] if n['tag'] == 'application']
    require(len(applications) == 1, 'ANDROID_MANIFEST_INVALID')
    application = applications[0]
    require(application['attrs'].get('android:debuggable', False) is False
            and application['attrs'].get('android:enabled', True) is True
            and application['attrs'].get('android:allowBackup') is False
            and application['attrs'].get('android:usesCleartextTraffic') is False,
            'ANDROID_RELEASE_CONFIGURATION_INVALID')
    filters = []
    for activity in application['children']:
        for intent in activity['children']:
            if intent['tag'] != 'intent-filter' or intent['attrs'].get('android:autoVerify') is not True:
                continue
            require(activity['tag'] == 'activity' and activity['attrs'].get('android:name')
                    in ('.MainActivity', APP_ID + '.MainActivity')
                    and activity['attrs'].get('android:exported') is True
                    and activity['attrs'].get('android:enabled', True) is True,
                    'ANDROID_CALLBACK_MANIFEST_INVALID')
            filters.append(intent)
    require(len(filters) == 1, 'ANDROID_CALLBACK_MANIFEST_INVALID')
    intent = filters[0]
    actions = {n['attrs'].get('android:name') for n in intent['children'] if n['tag'] == 'action'}
    categories = {n['attrs'].get('android:name') for n in intent['children'] if n['tag'] == 'category'}
    data = [n['attrs'] for n in intent['children'] if n['tag'] == 'data']
    require(actions == {'android.intent.action.VIEW'}
            and categories == {'android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE'}
            and len(data) == 2 and {n.get('android:path') for n in data} == {
                '/auth/native/android/callback', '/auth/native/android/logout'
            } and all(n == {'android:scheme': 'https', 'android:host': host,
                            'android:path': n.get('android:path')} for n in data),
            'ANDROID_CALLBACK_MANIFEST_INVALID')


def verify_archive(apk, web):
    with ZipFile(apk) as archive:
        entries = archive.infolist()
        require(len(entries) <= 16384 and len({n.filename for n in entries}) == len(entries)
                and sum(n.file_size for n in entries) <= MAX_EXPANDED, 'ANDROID_APK_ARCHIVE_INVALID')
        for info in entries:
            require(info.orig_filename == info.filename and safe_name(info.filename.rstrip('/'))
                    and not info.flag_bits & 1 and info.file_size <= MAX_FILE
                    and stat.S_IFMT(info.external_attr >> 16) in (0, stat.S_IFREG, stat.S_IFDIR),
                    'ANDROID_APK_ARCHIVE_INVALID')
        actual = {}
        for info in entries:
            if info.filename.startswith('assets/public/') and not info.is_dir():
                with archive.open(info) as stream:
                    actual[info.filename.removeprefix('assets/public/')] = digest(stream)
        require(actual == web, 'ANDROID_PACKAGED_WEB_BYTES_CHANGED')
        config = document(archive.read('assets/capacitor.config.json'))
        android = config.get('android') if isinstance(config, dict) else None
        server = config.get('server', {}) if isinstance(config, dict) else None
        require(isinstance(config, dict) and config.get('appId') == APP_ID
                and isinstance(android, dict) and isinstance(server, dict)
                and android.get('webContentsDebuggingEnabled') is False
                and android.get('allowMixedContent') is False
                and 'url' not in server, 'ANDROID_CAPACITOR_CONFIGURATION_INVALID')


def verify(args):
    settings = operator_document(args.settings)
    origin, host = checked_origin(settings)
    association = operator_document(args.association)
    certificates = expected_certificates(association)
    web = expected_web(args.web_bundle, origin)
    require(stat.S_ISREG(args.apk.lstat().st_mode) and not args.apk.is_symlink()
            and 0 < args.apk.stat().st_size <= MAX_APK, 'ANDROID_APK_INVALID')
    tools = args.build_tools
    suffix = '.exe' if os.name == 'nt' else ''
    with tempfile.TemporaryDirectory(prefix='paperquay-apk-verify-') as temporary:
        folder = Path(temporary).resolve(strict=True)
        require(folder.parent == Path(tempfile.gettempdir()).resolve(strict=True)
                and not folder.is_symlink(), 'ANDROID_SNAPSHOT_SCOPE_INVALID')
        snapshot = folder / 'package.apk'
        descriptor = os.open(args.apk, os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0))
        with os.fdopen(descriptor, 'rb') as source, snapshot.open('xb') as destination:
            require(stat.S_ISREG(os.fstat(source.fileno()).st_mode), 'ANDROID_APK_INVALID')
            total = 0
            while block := source.read(min(1024**2, MAX_APK - total + 1)):
                total += len(block)
                require(total <= MAX_APK, 'ANDROID_APK_INVALID')
                destination.write(block)
        require(snapshot.stat().st_size <= MAX_APK, 'ANDROID_APK_INVALID')
        checksum = file_hash(snapshot)
        signature = tool([args.java, '-jar', tools / 'lib/apksigner.jar',
                          'verify', '--verbose', '--print-certs', snapshot])
        fingerprint = signer_fingerprint(signature, certificates)
        badging = tool([tools / ('aapt2' + suffix), 'dump', 'badging', snapshot])
        package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'", badging)
        require(package is not None and package.groups() == (
            APP_ID, str(args.version_code), args.version_name) and 'application-debuggable' not in badging,
                'ANDROID_PACKAGE_VERSION_INVALID')
        verify_manifest(tool([tools / ('aapt2' + suffix), 'dump', 'xmltree', snapshot,
                              '--file', 'AndroidManifest.xml']), host)
        tool([tools / ('zipalign' + suffix), '-c', '-P', '16', '4', snapshot])
        verify_archive(snapshot, web)
        require(file_hash(snapshot) == checksum and file_hash(args.apk) == checksum,
                'ANDROID_APK_CHANGED_DURING_VERIFICATION')
    return {'status': 'SIGNED_ANDROID_PACKAGE_VERIFIED', 'packageId': APP_ID,
            'versionCode': args.version_code, 'versionName': args.version_name,
            'apkSha256': checksum, 'certificateSha256': fingerprint, 'webFilesVerified': len(web),
            'copiedWebBindingSha256': web['native-link-binding.json'],
            'originSha256': hashlib.sha256(origin.encode()).hexdigest(),
            'expectedAssociationCanonicalSha256': hashlib.sha256(json.dumps(
                association, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
            'signatureAndExpectedAssociationMatch': True, 'releaseConfigurationVerified': True,
            'osDomainAssociationChecked': False, 'loginChecked': False,
            'productionClientActivationPerformed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('apk', 'settings', 'association', 'web-bundle', 'build-tools', 'java'):
        parser.add_argument('--' + name, type=Path, required=True)
    parser.add_argument('--version-code', type=int, required=True)
    parser.add_argument('--version-name', required=True)
    args = parser.parse_args()
    try:
        require(1 <= args.version_code <= 2100000000 and 0 < len(args.version_name) <= 128,
                'ANDROID_PACKAGE_VERSION_INVALID')
        print(json.dumps(verify(args)))
    except VerificationError as error:
        print(json.dumps({'status': 'ANDROID_RELEASE_NOT_VERIFIED', 'code': str(error)}))
        return 1
    except Exception:
        print(json.dumps({'status': 'ANDROID_RELEASE_NOT_VERIFIED', 'code': 'ANDROID_RELEASE_INPUT_INVALID'}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
