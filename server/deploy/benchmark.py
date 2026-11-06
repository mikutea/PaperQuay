#!/usr/bin/env python3
"""Predeclared read-only capacity probe; private credentials/results stay outside Git."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection, HTTPSConnection, HTTPException
import json
import math
import os
from pathlib import Path
import re
import ssl
import time
from urllib.parse import urlsplit

import ops

# Deliberately modest initial invitation-service budget, not a claim about
# concurrent writes, PDF transfers, AI inference, or maximum system capacity.
BUDGET = {'formatVersion': 1, 'scenario': 'authenticated-pull-100', 'warmupRequests': 10,
          'measuredRequests': 120, 'requestsPerSecond': 1, 'maxConcurrent': 4,
          'responseBytesLimit': 4 * 1024**2, 'timeoutSeconds': 8,
          'minimumRecords': 100, 'minimumResponseBytes': 128 * 1024,
          'p95MillisecondsLimit': 500, 'p99MillisecondsLimit': 1500,
          'allowedFailures': 0}


def percentile(values, percent):
    ops.require(bool(values) and 0 < percent <= 100, 'SAMPLES_INVALID')
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * percent / 100) - 1)]


def profile(path):
    path = Path(path).absolute()
    ops.private_directory(path.parent)
    info = path.lstat()
    ops.require(path.is_file() and not path.is_symlink() and info.st_uid == os.geteuid()
                and not info.st_mode & 0o077 and info.st_size <= 16 * 1024, 'PRIVATE_PROFILE_REQUIRED')
    value = json.loads(path.read_text('utf-8'))
    ops.require(set(value) == {'apiBaseUrl', 'accessToken', 'revision'}, 'PROFILE_INVALID')
    url = urlsplit(value['apiBaseUrl'])
    ops.require((url.scheme == 'https' or url.scheme == 'http' and url.hostname == '127.0.0.1')
                and url.hostname and not url.username and not url.password and not url.query and not url.fragment
                and re.fullmatch(r'(?:/[A-Za-z0-9_-]+)*/?', url.path) is not None
                and re.fullmatch(r'[a-f0-9]{40}', value['revision']) is not None
                and isinstance(value['accessToken'], str)
                and re.fullmatch(r'[A-Za-z0-9_.-]{32,12000}', value['accessToken']) is not None, 'PROFILE_INVALID')
    return value, url


def request_once(value, url):
    started = time.monotonic()
    # Each request has its own validated connection, with no proxy/redirect or
    # credential-bearing URL. Bodies are consumed then discarded, never logged.
    connection = HTTPSConnection(url.hostname, url.port, timeout=BUDGET['timeoutSeconds'], context=ssl.create_default_context()) \
        if url.scheme == 'https' else HTTPConnection(url.hostname, url.port, timeout=BUDGET['timeoutSeconds'])
    result = {'milliseconds': 0, 'bytes': 0, 'status': 0, 'valid': False}
    try:
        connection.request('GET', url.path.rstrip('/') + '/v1/sync/pull?limit=100',
                           headers={'Authorization': 'Bearer ' + value['accessToken'], 'Accept': 'application/json'})
        response = connection.getresponse()
        result['status'] = response.status
        raw = response.read(BUDGET['responseBytesLimit'] + 1)
        result['bytes'] = len(raw)
        if response.status == 200 and len(raw) <= BUDGET['responseBytesLimit']:
            body = json.loads(raw)
            result['valid'] = (len(raw) >= BUDGET['minimumResponseBytes']
                               and isinstance(body, dict) and body.get('protocolVersion') == 1
                               and isinstance(body.get('records'), list) and len(body['records']) == BUDGET['minimumRecords']
                               and isinstance(body.get('hasMore'), bool))
    except (OSError, ValueError, TypeError, HTTPException):
        pass
    finally:
        connection.close()
        result['milliseconds'] = (time.monotonic() - started) * 1000
    return result


def run_probe(value, url):
    start = time.monotonic()
    futures = []
    with ThreadPoolExecutor(max_workers=BUDGET['maxConcurrent']) as pool:
        total = BUDGET['warmupRequests'] + BUDGET['measuredRequests']
        for index in range(total):
            due = start + index / BUDGET['requestsPerSecond']
            delay = due - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            # At most four requests in flight. Report overload instead of
            # silently queueing and disguising the scheduled arrival rate.
            pending = sum(not future.done() for future in futures)
            ops.require(pending < BUDGET['maxConcurrent'], 'PROBE_OVERLOADED')
            futures.append(pool.submit(request_once, value, url))
        all_results = [future.result() for future in futures]
    measured = all_results[BUDGET['warmupRequests']:]
    latencies = [item['milliseconds'] for item in measured]
    failures = sum(not item['valid'] for item in measured)
    p50, p95, p99 = (percentile(latencies, p) for p in (50, 95, 99))
    return {'format': 'paperquay-private-capacity', 'version': 1, 'at': ops.utc(),
            'revision': value['revision'], 'budget': BUDGET, 'elapsedSeconds': time.monotonic() - start,
            'warmupFailures': sum(not item['valid'] for item in all_results[:BUDGET['warmupRequests']]),
            'measured': {'requests': len(measured), 'failures': failures,
                         'rateLimited': sum(item['status'] == 429 for item in measured),
                         'serverErrors': sum(500 <= item['status'] <= 599 for item in measured),
                         'responseBytes': sum(item['bytes'] for item in measured),
                         'p50Milliseconds': p50, 'p95Milliseconds': p95, 'p99Milliseconds': p99},
            'passed': all(item['valid'] for item in all_results[:BUDGET['warmupRequests']])
                      and failures <= BUDGET['allowedFailures'] and p95 <= BUDGET['p95MillisecondsLimit']
                      and p99 <= BUDGET['p99MillisecondsLimit']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile', type=Path, required=True)
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    value, url = profile(args.profile)
    output = args.receipt.absolute()
    ops.private_directory(output.parent)
    ops.require(not output.exists() and not output.is_symlink(), 'NEW_RECEIPT_REQUIRED')
    result = run_probe(value, url)
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(result, stream, separators=(',', ':'), allow_nan=False)
        stream.write('\n')
    print(json.dumps({'status': 'measured', 'passed': result['passed'], 'sha256': ops.digest(output)}))
    if not result['passed']:
        raise SystemExit(1)


if __name__ == '__main__':
    try:
        main()
    except (ops.OpsError, ValueError, KeyError, TypeError, OSError):
        print(json.dumps({'error': 'CAPACITY_PROBE_FAILED'}))
        raise SystemExit(1) from None
