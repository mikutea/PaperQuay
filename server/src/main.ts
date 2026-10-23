import { buildApp } from './app.ts';
import { createOidcVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { PostgresSyncStore } from './store.ts';
import { ApiError } from './errors.ts';

let store: PostgresSyncStore | undefined;
try {
  const config = loadConfig();
  store = new PostgresSyncStore({ connectionString: config.databaseUrl, cursorSecret: config.cursorSecret });
  const verifyToken = await createOidcVerifier({ issuer: config.oidcIssuer, audience: config.oidcAudience, clientIds: config.oidcClientIds });
  const app = await buildApp({ config, repository: store, verifyToken, logger: {
    level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
  } });
  app.addHook('onClose', async () => store?.close());
  let shuttingDown = false;
  const stop = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await app.close();
  };
  process.once('SIGINT', () => { void stop(); });
  process.once('SIGTERM', () => { void stop(); });
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  await store?.close().catch(() => undefined);
  process.stderr.write((error instanceof ApiError ? error.code : 'SERVER_START_FAILED') + '\n');
  process.exitCode = 1;
}
