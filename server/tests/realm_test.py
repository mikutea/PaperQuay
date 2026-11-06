"""Production configuration stays distinct from the disposable direct-grant realm."""
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'deploy'))
import realm


class RealmTests(unittest.TestCase):
    def test_production_has_no_users_secrets_wildcards_or_password_grant(self):
        value = realm.production_realm('https://reader.example.test/')
        self.assertEqual(value['realm'], 'paperquay')
        self.assertFalse(value['registrationAllowed'])
        self.assertFalse(value['resetPasswordAllowed'])
        self.assertNotIn('users', value)
        self.assertNotIn('smtpServer', value)
        self.assertEqual(len(value['clients']), 2)
        for client in value['clients']:
            self.assertTrue(client['publicClient'])
            self.assertTrue(client['standardFlowEnabled'])
            self.assertFalse(client['directAccessGrantsEnabled'])
            self.assertFalse(client['implicitFlowEnabled'])
            self.assertFalse(client['serviceAccountsEnabled'])
            self.assertFalse(client['fullScopeAllowed'])
            self.assertIn('basic', client['defaultClientScopes'])
            self.assertEqual(client['attributes']['pkce.code.challenge.method'], 'S256')
            self.assertNotIn('*', json.dumps(client['redirectUris']))
            self.assertNotIn('secret', client)
        self.assertEqual(value['clients'][1]['redirectUris'], ['http://127.0.0.1/paperquay-oidc/callback'])

    def test_production_origin_refuses_userinfo_non_https_paths_and_wildcards(self):
        for invalid in ('http://reader.example.test', 'https://reader.example.test/path',
                        'https://name:password@reader.example.test', 'https://*.example.test',
                        'https://reader.example.test?token=private', 'https://reader.example.test:444'):
            with self.assertRaises(realm.ops.OpsError):
                realm.production_realm(invalid)


if __name__ == '__main__':
    unittest.main()
