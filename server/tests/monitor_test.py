"""Private monitoring must discard identifiers and fail closed on unsafe output."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
import monitor


def metrics():
    return {'format': 'paperquay-private-metrics', 'version': 1, 'at': monitor.ops.utc(), 'uptimeSeconds': 30,
            'requests': {'attempted': 3, 'active': 0, 'completed': 2, 'aborted': 1, 'statusClasses': [0, 1, 0, 0, 1]},
            'latency': {'boundsMs': [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 15000],
                        'counts': [1] + [0] * 9 + [1], 'sumMs': 15020, 'maxMs': 15010},
            'process': dict.fromkeys(['rssBytes', 'heapUsedBytes', 'externalBytes', 'cpuUserMicroseconds', 'cpuSystemMicroseconds'], 32)}


class MonitorTests(unittest.TestCase):
    def test_logs_allow_only_known_numeric_aggregates(self):
        value = metrics()
        value.update(accountId='private-account-sentinel', url='private-url-sentinel')
        value['requests']['secret'] = 'private-key-sentinel'
        wire = 'not-json\n' + json.dumps({'message': 'private-body-sentinel'}) + '\n' + json.dumps({'paperquayPrivateMetrics': value})
        clean = monitor.latest_metrics(wire)
        self.assertNotIn('sentinel', json.dumps(clean))
        self.assertEqual(clean['requests']['completed'], 2)
        for broken in (float('nan'), float('inf'), -1, True, 'secret'):
            value['requests']['active'] = broken
            with self.assertRaises(monitor.ops.OpsError):
                monitor.latest_metrics(json.dumps({'paperquayPrivateMetrics': value}))

    def test_real_docker_stats_are_numeric_and_do_not_retain_container_names(self):
        metadata = {'State': {'Running': True, 'Health': {'Status': 'healthy'}}, 'RestartCount': 2}
        value = {'cpu': '12.34%', 'memory': '22.5MiB / 512MiB', 'network': '1.2MB / 500kB', 'block': '0B / 20KiB'}
        with patch.object(monitor, 'capture', return_value=json.dumps(value)):
            result = monitor.container_stats('private-container-sentinel', metadata)
        self.assertEqual(result['networkBytes'], [1200000, 500000])
        self.assertEqual(result['memoryBytes'], [23592960, 536870912])
        self.assertNotIn('sentinel', json.dumps(result))
        with self.assertRaises(monitor.ops.OpsError):
            monitor.quantity('a private unparseable error')

    @unittest.skipIf(os.name == 'nt', 'POSIX owner, mode, symlink and NOFOLLOW semantics')
    def test_private_rotating_log_is_bounded_and_rejects_symlink_output(self):
        with tempfile.TemporaryDirectory(prefix='paperquay-monitor-') as name:
            directory = Path(name).resolve()
            os.chmod(directory, 0o700)
            for index in range(20):
                monitor.append_private(directory, {'sample': index, 'value': 'x' * 40}, maximum=200)
            self.assertLessEqual((directory / 'monitor.jsonl').stat().st_size, 200)
            self.assertLessEqual((directory / 'monitor.previous.jsonl').stat().st_size, 200)
            self.assertEqual((directory / 'monitor.jsonl').stat().st_mode & 0o777, 0o600)
            (directory / 'monitor.jsonl').rename(directory / 'original')
            (directory / 'monitor.jsonl').symlink_to(directory / 'original')
            with self.assertRaises(monitor.ops.OpsError):
                monitor.append_private(directory, {'sample': 21})


if __name__ == '__main__':
    unittest.main()
