import { parseAccountIdentity, type AccountIdentity } from '../api.ts';
import type { AuthSubject } from '../auth/oidc.ts';
import type { AppConfig } from '../config.ts';
import { ClientError } from '../errors.ts';
import type { SecretStore } from '../platform/secretStore.ts';

/** This is a previously server-verified mapping, never a token-claim account id. */
export function verifiedBinding(config: AppConfig, secrets: SecretStore, subject: () => AuthSubject | null) {
  const namespace = JSON.stringify(['verified-account-v1', config.apiBaseUrl, config.oidcAuthority, config.oidcClientId]);
  const currentSubject = () => {
    const current = subject();
    if (!current || current.issuer !== config.oidcAuthority || !current.subject || current.subject.length > 2048)
      throw new ClientError('AUTH_REQUIRED');
    return current.subject;
  };
  const address = async (sub: string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([namespace, sub])));
    return `paperquay-verified-account:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  };
  return {
    key: () => {
      const current = subject();
      return current?.issuer === config.oidcAuthority ? JSON.stringify([namespace, current.subject]) : null;
    },
    async read(): Promise<AccountIdentity | null> {
      const sub = currentSubject();
      const stored = await secrets.get(await address(sub), 'identity');
      if (currentSubject() !== sub) throw new ClientError('ACCOUNT_CHANGED');
      if (!stored) return null;
      try {
        const row = JSON.parse(stored);
        if (row.version !== 1 || row.subject !== sub) return null;
        const identity = parseAccountIdentity(row.identity);
        return identity.device.revokedAt === null ? identity : null;
      } catch { throw new ClientError('STORAGE_CORRUPT'); }
    },
    async write(identity: AccountIdentity): Promise<void> {
      const sub = currentSubject();
      const verified = parseAccountIdentity(identity);
      if (verified.device.revokedAt !== null) throw new ClientError('SESSION_REVOKED');
      await secrets.set(await address(sub), 'identity', JSON.stringify({ version: 1, subject: sub, identity: verified }));
      if (currentSubject() !== sub) throw new ClientError('ACCOUNT_CHANGED');
    },
    async remove(): Promise<void> { await secrets.remove(await address(currentSubject()), 'identity'); },
  };
}
