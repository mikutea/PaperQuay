#!/usr/bin/env python3
"""Prefill SwiftPM's binary cache with checksum-pinned official release assets."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading

# These are the binaryTarget checksums in the exact-version upstream manifest:
# https://github.com/ionic-team/capacitor-swift-pm/blob/8.5.3/Package.swift
# https://github.com/sqlcipher/SQLCipher.swift/blob/4.20.0/Package.swift
PINNED_RELEASES = [
    ('ionic-team/capacitor-swift-pm', '8.5.3', {
        'Capacitor.xcframework.zip': '9316f568444411d362dcb4d1946e7572d4aef5d690c122ff6f1cb8a44a920c9f',
        'Cordova.xcframework.zip': 'bdcd8eab2d62a077efd76c3c8b9629e65ae7043c1462289a1e55de9be19bbf1f',
    }),
    ('sqlcipher/SQLCipher.swift', '4.20.0', {
        'SQLCipher.xcframework.zip': '1505174fe7f8a0fe81d6ebf87a64b17701b500c12a445ef6b68b9159f012d747',
    }),
]
MAX_BYTES = 128 * 1024 * 1024


class ArtifactError(Exception):
    pass


def require(value, reason):
    if not value:
        raise ArtifactError(reason)


def digest(file):
    value = hashlib.sha256()
    with Path(file).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(chunk)
    return value.hexdigest()


def cache_key(repository, version, name):
    url = f'https://github.com/{repository}/releases/download/{version}/{name}'
    # SwiftPM BinaryArtifactsManager uses spm_mangledToC99ExtendedIdentifier.
    # These pinned URLs contain ASCII only and begin with an identifier letter.
    return re.sub(r'[^A-Za-z0-9_]', '_', url)


def validate_release(release, version, expected):
    require(isinstance(release, dict), 'INVALID_RELEASE')
    require(release.get('tag_name') == version and release.get('draft') is False, 'UNEXPECTED_RELEASE')
    assets = release.get('assets')
    require(isinstance(assets, list), 'INVALID_ASSETS')
    require(all(isinstance(asset, dict) for asset in assets), 'INVALID_ASSET')
    output = []
    for name, checksum in expected.items():
        matches = [asset for asset in assets if asset.get('name') == name]
        require(len(matches) == 1, 'MISSING_OR_DUPLICATE_ASSET')
        asset = matches[0]
        require(type(asset.get('id')) is int and asset['id'] > 0, 'INVALID_ASSET_ID')
        require(type(asset.get('size')) is int and 0 < asset['size'] <= MAX_BYTES, 'INVALID_ASSET_SIZE')
        require(asset.get('state') == 'uploaded' and asset.get('digest') == 'sha256:' + checksum,
                'ASSET_DIGEST_DIFFERS_FROM_PINNED_MANIFEST')
        output.append(asset)
    return output


def download(gh, repository, version, expected, asset, directory, env):
    name = asset['name']
    require(name in expected, 'UNEXPECTED_ARTIFACT')
    destination = directory / cache_key(repository, version, name)
    if destination.exists():
        require(destination.is_file() and not destination.is_symlink(), 'UNSAFE_CACHE_ENTRY')
        require(destination.stat().st_size == asset['size'] and digest(destination) == expected[name],
                'EXISTING_CACHE_ENTRY_INVALID')
        return {'name': name, 'bytes': asset['size'], 'sha256': expected[name], 'reused': True}
    pending = destination.with_name(destination.name + '.download')
    require(not pending.exists() and not pending.is_symlink(), 'INSPECT_RETAINED_PARTIAL_BEFORE_RETRY')
    command = [gh, 'api', '--hostname', 'github.com',
               f'repos/{repository}/releases/assets/{asset["id"]}', '-H', 'Accept: application/octet-stream']
    with pending.open('xb') as target, subprocess.Popen(command, stdout=subprocess.PIPE,
                                                       stderr=subprocess.DEVNULL, env=env) as child:
        timed_out = threading.Event()
        def terminate():
            timed_out.set()
            try:
                child.kill()
            except ProcessLookupError:
                pass
        timer = threading.Timer(180, terminate)
        timer.daemon = True
        timer.start()
        size = 0
        try:
            for chunk in iter(lambda: child.stdout.read(1024 * 1024), b''):
                size += len(chunk)
                if size > asset['size']:
                    child.kill()
                    raise ArtifactError('DOWNLOAD_EXCEEDS_DECLARED_SIZE')
                target.write(chunk)
            code = child.wait()
            require(not timed_out.is_set(), 'DOWNLOAD_TIMEOUT')
            require(code == 0, 'GITHUB_ASSET_DOWNLOAD_FAILED')
        finally:
            timer.cancel()
            if child.poll() is None:
                child.kill()
    require(size == asset['size'] and digest(pending) == expected[name], 'DOWNLOADED_CHECKSUM_MISMATCH')
    pending.rename(destination)
    return {'name': name, 'bytes': size, 'sha256': expected[name], 'reused': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-root', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    lock = json.loads((root / 'apps/mobile/package-lock.json').read_text('utf-8'))
    require(lock['packages']['node_modules/@capacitor/ios']['version'] == PINNED_RELEASES[0][1],
            'UPDATE_PINNED_ARTIFACTS_FOR_NEW_CAPACITOR_VERSION')
    require(lock['packages']['node_modules/@capacitor-community/sqlite']['version'] == '8.1.1',
            'UPDATE_PINNED_ARTIFACTS_FOR_NEW_SQLITE_PLUGIN_VERSION')
    gh = shutil.which('gh')
    require(gh is not None, 'GITHUB_CLI_REQUIRED')
    env = {**os.environ, 'GH_HOST': 'github.com', 'GH_DEBUG': ''}
    cache = args.cache_root.absolute()
    for parent in [cache, *cache.parents]:
        require(not parent.is_symlink(), 'LINKED_CACHE_PATH_REJECTED')
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory = cache / 'artifacts'
    require(not directory.is_symlink(), 'LINKED_CACHE_PATH_REJECTED')
    directory.mkdir(mode=0o700, exist_ok=True)
    results = []
    for repository, version, expected in PINNED_RELEASES:
        metadata = subprocess.run([gh, 'api', '--hostname', 'github.com',
                                   f'repos/{repository}/releases/tags/{version}'],
                                  capture_output=True, text=True, timeout=45, env=env)
        require(metadata.returncode == 0, 'GITHUB_RELEASE_METADATA_FAILED')
        require(len(metadata.stdout) <= 1024 * 1024, 'METADATA_TOO_LARGE')
        assets = validate_release(json.loads(metadata.stdout), version, expected)
        results.extend(download(gh, repository, version, expected, asset, directory, env) for asset in assets)
    print(json.dumps({'format': 'paperquay-swiftpm-artifact-cache',
                      'assets': results, 'upstreamManifestUnmodified': True}))


if __name__ == '__main__':
    try:
        main()
    except (ArtifactError, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        print(json.dumps({'error': str(error) if isinstance(error, ArtifactError) else 'ARTIFACT_CACHE_PREPARATION_FAILED'}))
        raise SystemExit(1) from None
