import {ModelGatewayDriver} from './model-gateway-driver.ts';
import {modelGatewayAuthorized,modelGatewayProfile} from './model-config.ts';
import { buildApp } from './app.ts';
import { createOidcVerifier } from './auth.ts';
import { loadConfig } from './config.ts';
import { PostgresSyncStore } from './store.ts';
import { ApiError } from './errors.ts';

let store: PostgresSyncStore | undefined;
try {
  const config = loadConfig();
  store = new PostgresSyncStore({ connectionString: config.databaseUrl, erasureConnectionString: config.erasureDatabaseUrl, cursorSecret: config.cursorSecret,
    maxAccountRetainedBytes: config.maxAccountRetainedBytes, cloudPdfEnabled: config.cloudPdfEnabled,
    cloudPdfAccountBytes: config.cloudPdfAccountBytes });
  const verifyToken = await createOidcVerifier({ issuer: config.oidcIssuer, audience: config.oidcAudience, clientIds: config.oidcClientIds });
  const modelInference=store.modelInference({gateway:who=>config.modelInferenceEnabled&&config.modelGateway&&modelGatewayAuthorized(config.modelGateway,who.subject)?modelGatewayProfile(config.modelGateway,config.cursorSecret):null});
  const gateway=config.modelInferenceEnabled&&config.modelGateway?new ModelGatewayDriver({repository:modelInference,getConfiguration:()=>config.modelGateway??null,serverSecret:config.cursorSecret}):undefined;
  const app = await buildApp({ config, repository: store, accountPrivacyRepository:store.privacy(),cloudPdfRepository: store, desktopPdfRepository: store,remoteTaskRepository:store.remoteTasks(),remoteRetrievalRepository:store.remoteRetrieval(),modelInferenceRepository:modelInference,modelGatewayDriver:gateway, verifyToken, logger: {
    level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
  } });
  app.addHook('onClose', async () => {await gateway?.close();await store?.close();});
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
