import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import {
  parseAccountModelSettings, type AccountModelSettings,
} from '../../packages/ai-core/src/accountModel.ts';
import type { VerifiedIdentity } from './auth.ts';
import { ApiError } from './errors.ts';

type WithAccount = <T>(identity: VerifiedIdentity, work: (context: {
  client: PoolClient;
  account: { id: string };
}) => Promise<T>) => Promise<T>;

export interface AccountModelRepository {
  read(identity: VerifiedIdentity): Promise<AccountModelSettings>;
  save(identity: VerifiedIdentity, settings: AccountModelSettings): Promise<AccountModelSettings>;
}

const associatedData = (accountId: string, revision: number) =>
  Buffer.from(JSON.stringify(['paperquay-account-model', 1, accountId, revision]));

export function createAccountModelRepository(withAccount: WithAccount, key: Uint8Array): AccountModelRepository {
  if (key.byteLength !== 32) throw new ApiError('CONFIGURATION_INVALID', 500);
  const secret = Buffer.from(key);
  const table = 'paperquay.account_model_settings';
  return {
    read(identity) {
      return withAccount(identity, async ({ client, account }) => {
        const { rows } = await client.query<{ revision: number; sealed: string | null }>(
          `SELECT revision, sealed FROM ${table} WHERE account_id = $1`, [account.id],
        );
        const row = rows[0];
        if (!row?.sealed) return { revision: row?.revision ?? 0, connection: null };
        try {
          const bytes = Buffer.from(row.sealed, 'base64url');
          const decipher = createDecipheriv('aes-256-gcm', secret, bytes.subarray(0, 12));
          decipher.setAAD(associatedData(account.id, row.revision));
          decipher.setAuthTag(bytes.subarray(12, 28));
          const clear = Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
          return parseAccountModelSettings({ revision: row.revision, connection: JSON.parse(clear.toString('utf8')) });
        } catch {
          throw new ApiError('ACCOUNT_MODEL_UNAVAILABLE', 503);
        }
      });
    },
    save(identity, settings) {
      return withAccount(identity, async ({ client, account }) => {
        const { rows } = await client.query<{ revision: number }>(
          `SELECT revision FROM ${table} WHERE account_id = $1`, [account.id],
        );
        const current = rows[0]?.revision ?? 0;
        if (settings.revision !== current) throw new ApiError('ACCOUNT_MODEL_CHANGED', 409);
        if (current === 2147483647) throw new ApiError('ACCOUNT_MODEL_UNAVAILABLE', 503);
        const revision = current + 1;
        let sealed: string | null = null;
        if (settings.connection) {
          const iv = randomBytes(12);
          const cipher = createCipheriv('aes-256-gcm', secret, iv);
          cipher.setAAD(associatedData(account.id, revision));
          const encrypted = Buffer.concat([cipher.update(JSON.stringify(settings.connection), 'utf8'), cipher.final()]);
          sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
        }
        await client.query(`INSERT INTO ${table} (account_id, revision, sealed) VALUES ($1, $2, $3)
          ON CONFLICT (account_id) DO UPDATE SET revision = EXCLUDED.revision, sealed = EXCLUDED.sealed`,
        [account.id, revision, sealed]);
        return { revision, connection: settings.connection };
      });
    },
  };
}

export function registerAccountModelRoutes(
  app: FastifyInstance,
  repository: AccountModelRepository,
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
) {
  const route = '/v1/account-model';
  app.get(route, { onRequest: authenticate }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return repository.read(request.identity!);
  });
  app.put(route, { onRequest: authenticate, bodyLimit: 16 * 1024 }, async (request, reply) => {
    let settings: AccountModelSettings;
    try {
      settings = parseAccountModelSettings(request.body);
    } catch {
      throw new ApiError('ACCOUNT_MODEL_INVALID', 400);
    }
    reply.header('Cache-Control', 'no-store');
    const saved = await repository.save(request.identity!, settings);
    return { revision: saved.revision };
  });
}
