#!/usr/bin/env python3
"""Bounded, private, read-only monitoring of one validated dedicated stack."""
import argparse
import datetime
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time
from http.client import HTTPConnection

import ops


def capture(args):
    try:
        value = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15)
        ops.require(value.returncode == 0 and len(value.stdout) <= 2 * 1024**2, 'MONITOR_READ_FAILED')
        return value.stdout.decode('utf-8')
    except (OSError, ValueError, subprocess.TimeoutExpired):
        raise ops.OpsError('MONITOR_READ_FAILED') from None


def number(value):
    ops.require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 2**63, 'METRICS_INVALID')
    return value


def aggregates(value):
    """Reconstruct an allowlist; unknown log fields are never copied."""
    ops.require(isinstance(value, dict) and value.get('format') == 'paperquay-private-metrics'
                and value.get('version') == 1, 'METRICS_INVALID')
    recorded = datetime.datetime.fromisoformat(value['at'].replace('Z', '+00:00'))
    ops.require(recorded.tzinfo is not None, 'METRICS_INVALID')
    age = (datetime.datetime.now(datetime.timezone.utc) - recorded).total_seconds()
    ops.require(-5 <= age <= 3615, 'METRICS_STALE')
    requests, latency, process = (value[key] for key in ('requests', 'latency', 'process'))
    bounds = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000]
    ops.require(latency.get('boundsMs') == bounds and len(latency['counts']) == len(bounds) + 1
                and len(requests['statusClasses']) == 5, 'METRICS_INVALID')
    return {'recordedAt': recorded.isoformat(), 'ageSeconds': max(0, age), 'uptimeSeconds': number(value['uptimeSeconds']),
            'requests': {**{key: number(requests[key]) for key in ('attempted', 'active', 'completed', 'aborted')},
                         'statusClasses': [number(item) for item in requests['statusClasses']]},
            'latency': {'boundsMs': bounds, 'counts': [number(item) for item in latency['counts']],
                        'sumMs': number(latency['sumMs']), 'maxMs': number(latency['maxMs'])},
            'process': {key: number(process[key]) for key in ('rssBytes', 'heapUsedBytes', 'externalBytes',
                                                             'cpuUserMicroseconds', 'cpuSystemMicroseconds')}}


def latest_metrics(logs):
    for line in reversed(logs.splitlines()):
        try:
            value = json.loads(line)
            if 'paperquayPrivateMetrics' in value:
                return aggregates(value['paperquayPrivateMetrics'])
        except (ValueError, KeyError, TypeError, ops.OpsError):
            continue
    raise ops.OpsError('METRICS_NOT_AVAILABLE')


def quantity(value):
    match = re.fullmatch(r'([0-9]+(?:\.[0-9]+)?)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)', value.strip())
    ops.require(bool(match), 'STATS_INVALID')
    powers = {'B': 1, 'kB': 1000, 'KB': 1000, 'KiB': 1024, 'MB': 1000**2, 'MiB': 1024**2,
              'GB': 1000**3, 'GiB': 1024**3, 'TB': 1000**4, 'TiB': 1024**4}
    return int(number(float(match[1]) * powers[match[2]]))


def pair(value):
    parts = value.split('/')
    ops.require(len(parts) == 2, 'STATS_INVALID')
    return [quantity(item) for item in parts]


def container_stats(container, metadata):
    state = metadata['State']
    result = {'running': state['Running'] is True, 'restarts': number(metadata['RestartCount']),
              'healthy': state.get('Health', {}).get('Status') == 'healthy'}
    if result['running']:
        value = json.loads(capture(['docker', 'stats', '--no-stream', '--format',
            '{"cpu":{{json .CPUPerc}},"memory":{{json .MemUsage}},"network":{{json .NetIO}},"block":{{json .BlockIO}}}', container]))
        ops.require(re.fullmatch(r'[0-9]+(?:\.[0-9]+)?%', value['cpu']) is not None, 'STATS_INVALID')
        result.update(cpuPercent=number(float(value['cpu'][:-1])), memoryBytes=pair(value['memory']),
                      networkBytes=pair(value['network']), blockBytes=pair(value['block']))
    return result


QUEUE_SQL = """BEGIN READ ONLY;
SET LOCAL statement_timeout='5s';
SELECT json_build_object(
 'remoteQueued',(SELECT count(*) FROM paperquay.remote_tasks WHERE state='queued'),
 'remoteActive',(SELECT count(*) FROM paperquay.remote_tasks WHERE state IN ('running','cancel_requested')),
 'modelQueued',(SELECT count(*) FROM paperquay.model_inference_jobs WHERE state='queued'),
 'modelActive',(SELECT count(*) FROM paperquay.model_inference_jobs WHERE state IN ('running','cancel_requested')),
 'modelUncertain',(SELECT count(*) FROM paperquay.model_inference_jobs WHERE state='uncertain'),
 'applicationDatabaseBytes',pg_database_size('paperquay'),
 'identityDatabaseBytes',pg_database_size('paperquay_identity'));
COMMIT;"""


def sample(stack):
    started = time.monotonic()
    containers, errors, metadata = {}, [], {}
    for service in ops.SERVICES:
        try:
            container, info = stack.container(service)
            metadata[service] = (container, info)
            containers[service] = container_stats(container, info)
        except ops.OpsError:
            errors.append(service + '_UNAVAILABLE')
    free = shutil.disk_usage(stack.directory)
    result = {'format': 'paperquay-private-monitor', 'version': 1, 'at': ops.utc(),
              'containers': containers, 'disk': {'totalBytes': free.total, 'freeBytes': free.free}, 'errors': errors}
    try:
        port = int(stack.env['PAPERQUAY_LOCAL_PORT'])
        ops.require(1 <= port <= 65535, 'PORT_INVALID')
        # Fixed loopback destination; no operator-supplied URL or redirect.
        connection = HTTPConnection('127.0.0.1', port, timeout=4)
        try:
            health_started = time.monotonic()
            connection.request('GET', '/api/health/ready')
            response = connection.getresponse()
            payload = json.loads(response.read(4097))
            result['readiness'] = {'ready': response.status == 200 and payload.get('status') == 'ready',
                                   'milliseconds': (time.monotonic() - health_started) * 1000}
            if not result['readiness']['ready']:
                errors.append('READINESS_FAILED')
        finally:
            connection.close()
    except (OSError, ValueError, KeyError, TypeError, ops.OpsError):
        errors.append('READINESS_FAILED')
    if 'database' in metadata:
        try:
            lines = capture(ops.psql(metadata['database'][0], 'paperquay', QUEUE_SQL)).splitlines()
            value = json.loads(next(line for line in lines if line.startswith('{')))
            keys = ('remoteQueued', 'remoteActive', 'modelQueued', 'modelActive', 'modelUncertain',
                    'applicationDatabaseBytes', 'identityDatabaseBytes')
            result['queues'] = {key: number(value[key]) for key in keys}
        except (ops.OpsError, ValueError, KeyError, StopIteration, TypeError):
            errors.append('QUEUE_READ_FAILED')
    if 'sync' in metadata:
        try:
            result['http'] = latest_metrics(capture(['docker', 'logs', '--since', '65m', '--tail', '256', metadata['sync'][0]]))
        except ops.OpsError:
            errors.append('METRICS_NOT_AVAILABLE')
    result['collectionSeconds'] = time.monotonic() - started
    return result


def append_private(directory, value, maximum=4 * 1024**2):
    """Two bounded files, no symlinks or multi-writer execution."""
    directory = ops.private_directory(directory)
    path, previous = directory / 'monitor.jsonl', directory / 'monitor.previous.jsonl'
    for candidate in (path, previous):
        if candidate.exists() or candidate.is_symlink():
            info = candidate.lstat()
            ops.require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                        and not stat.S_IMODE(info.st_mode) & 0o077, 'PRIVATE_MONITOR_REQUIRED')
    wire = (json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    ops.require(len(wire) <= 64 * 1024 and len(wire) <= maximum, 'MONITOR_TOO_LARGE')
    if path.exists() and path.stat().st_size + len(wire) > maximum:
        os.replace(path, previous)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'ab') as stream:
        stream.write(wire)
        stream.flush()
        os.fsync(stream.fileno())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--output-directory', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=1)
    parser.add_argument('--interval', type=int, default=60)
    args = parser.parse_args()
    ops.require(1 <= args.samples <= 1440 and 15 <= args.interval <= 3600, 'MONITOR_ARGUMENTS_INVALID')
    output = ops.private_directory(args.output_directory)
    stack = ops.Stack(args.directory)
    with ops.operation_lock(output):
        for index in range(args.samples):
            append_private(output, sample(stack))
            print(json.dumps({'status': 'sampled', 'number': index + 1}), flush=True)
            if index + 1 < args.samples:
                time.sleep(args.interval)


if __name__ == '__main__':
    try:
        main()
    except (ops.OpsError, ValueError, KeyError, TypeError):
        print(json.dumps({'error': 'PRIVATE_MONITOR_FAILED'}))
        raise SystemExit(1) from None
