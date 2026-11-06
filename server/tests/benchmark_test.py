import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
import benchmark


class BenchmarkTests(unittest.TestCase):
    def test_percentiles_and_predeclared_workload_cannot_claim_an_empty_library(self):
        self.assertEqual(benchmark.percentile(list(range(1, 101)), 50), 50)
        self.assertEqual(benchmark.percentile(list(range(1, 101)), 95), 95)
        self.assertEqual(benchmark.percentile(list(range(1, 101)), 99), 99)
        self.assertGreaterEqual(benchmark.BUDGET['measuredRequests'], 100)
        self.assertEqual(benchmark.BUDGET['minimumRecords'], 100)
        self.assertGreater(benchmark.BUDGET['minimumResponseBytes'], 100000)

    def test_real_http_probe_is_bounded_does_not_redirect_and_discards_private_payload(self):
        case = {'status': 200, 'records': 100, 'paths': [], 'auth': []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                case['paths'].append(self.path)
                case['auth'].append(self.headers.get('Authorization'))
                self.send_response(case['status'])
                if case['status'] == 302:
                    self.send_header('Location', '/never-follow')
                self.end_headers()
                self.wfile.write(json.dumps({'protocolVersion': 1, 'records': [
                    {'text': 'private-note-sentinel-' * 90} for _ in range(case['records'])],
                    'nextCursor': None, 'hasMore': False}).encode())

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            url = urlsplit('http://127.0.0.1:' + str(server.server_port) + '/api')
            value = {'accessToken': 'synthetic-private-token'}
            result = benchmark.request_once(value, url)
            self.assertTrue(result['valid'])
            self.assertNotIn('private', json.dumps(result))
            self.assertEqual(case['paths'], ['/api/v1/sync/pull?limit=100'])
            self.assertEqual(case['auth'], ['Bearer synthetic-private-token'])
            case['status'] = 302
            self.assertFalse(benchmark.request_once(value, url)['valid'])
            self.assertNotIn('/never-follow', case['paths'])
            case.update(status=200, records=0)
            self.assertFalse(benchmark.request_once(value, url)['valid'])
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=2)


if __name__ == '__main__':
    unittest.main()
