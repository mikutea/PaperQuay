#!/usr/bin/env python3
"""Render a credential-free, invite-only production realm outside Git."""
import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit

import ops


def production_realm(web_origin):
    url = urlsplit(web_origin)
    ops.require(url.scheme == 'https' and url.hostname and not url.username and not url.password
                and url.path in ('', '/') and not url.query and not url.fragment
                and '*' not in web_origin and url.port in (None, 443), 'EXACT_HTTPS_ORIGIN_REQUIRED')
    origin = 'https://' + url.hostname
    audience = {'name': 'paperquay-sync-audience', 'protocol': 'openid-connect',
                'protocolMapper': 'oidc-audience-mapper', 'consentRequired': False,
                'config': {'included.custom.audience': 'paperquay-sync', 'access.token.claim': 'true',
                           'id.token.claim': 'false', 'lightweight.claim': 'true'}}

    def client(client_id, redirects, origins):
        return {'clientId': client_id, 'name': 'PaperQuay', 'enabled': True,
                'protocol': 'openid-connect', 'publicClient': True, 'standardFlowEnabled': True,
                'directAccessGrantsEnabled': False, 'implicitFlowEnabled': False,
                'serviceAccountsEnabled': False, 'fullScopeAllowed': False,
                # The pinned Keycloak basic scope supplies the server-owned
                # subject and genuine session auth_time, including on refresh.
                'defaultClientScopes': ['basic', 'profile', 'email'], 'optionalClientScopes': [],
                'redirectUris': redirects, 'webOrigins': origins,
                'attributes': {'pkce.code.challenge.method': 'S256',
                               'client.use.lightweight.access.token.enabled': 'false'},
                'protocolMappers': [audience]}

    mobile = client('paperquay-mobile', [origin + '/auth/callback', 'dev.paperquay.mobile://auth/callback'],
                    [origin, 'capacitor://localhost', 'http://localhost', 'https://localhost'])
    mobile['attributes']['post.logout.redirect.uris'] = origin + '/##dev.paperquay.mobile://auth/callback'
    desktop = client('paperquay-desktop', ['http://127.0.0.1/paperquay-oidc/callback'], [])
    return {'realm': 'paperquay', 'enabled': True, 'displayName': 'PaperQuay',
            'sslRequired': 'all', 'registrationAllowed': False, 'registrationEmailAsUsername': False,
            'resetPasswordAllowed': False, 'editUsernameAllowed': False, 'duplicateEmailsAllowed': False,
            'rememberMe': False, 'loginWithEmailAllowed': True, 'bruteForceProtected': True,
            'permanentLockout': False, 'failureFactor': 5, 'waitIncrementSeconds': 60,
            'maxFailureWaitSeconds': 900, 'maxDeltaTimeSeconds': 3600,
            'passwordPolicy': 'length(14) and notUsername(undefined) and notEmail(undefined)',
            'accessTokenLifespan': 300, 'ssoSessionIdleTimeout': 1800, 'ssoSessionMaxLifespan': 28800,
            'revokeRefreshToken': True, 'refreshTokenMaxReuse': 0,
            'eventsEnabled': True, 'eventsExpiration': 604800, 'eventsListeners': [],
            'enabledEventTypes': ['LOGIN_ERROR', 'CODE_TO_TOKEN_ERROR', 'REFRESH_TOKEN_ERROR',
                                  'UPDATE_PASSWORD', 'REMOVE_TOTP', 'UPDATE_TOTP'],
            'adminEventsEnabled': True, 'adminEventsDetailsEnabled': False,
            'clients': [mobile, desktop]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--web-origin', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    target = args.output.absolute()
    ops.private_directory(target.parent)
    value = production_realm(args.web_origin)
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
    print(json.dumps({'status': 'rendered', 'credentialsIncluded': False, 'sha256': ops.digest(target)}))


if __name__ == '__main__':
    try:
        main()
    except (ops.OpsError, ValueError, OSError):
        print(json.dumps({'error': 'REALM_CONFIGURATION_FAILED'}))
        raise SystemExit(1) from None
