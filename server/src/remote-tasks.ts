import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REMOTE_TASK_LIMITS, RemoteTaskValidationError, validateRemoteTaskFailure, validateRemoteTaskId,
  validateRemoteTaskLease, validateRemoteTaskProfiles, validateRemoteTaskRequest, validateRemoteTaskResume } from '../../packages/sync-core/src/remoteTasks.ts';
import type { RemoteTaskLease } from '../../packages/sync-core/src/remoteTasks.ts';
import { ApiError } from './errors.ts';
import type { RemoteTaskRepository } from './remote-task-store.ts';

export const REMOTE_TASK_CAPABILITY = Object.freeze({ protocolVersion: 1, transport: 'persistent-jobs-v1',
  maxArtifactBytes: REMOTE_TASK_LIMITS.artifactBytes, maxAccountArtifactBytes: REMOTE_TASK_LIMITS.accountArtifactBytes,
  maxActive: REMOTE_TASK_LIMITS.active, maxQueued: REMOTE_TASK_LIMITS.queued, maxRetained: REMOTE_TASK_LIMITS.retained,
  maxReceipts: REMOTE_TASK_LIMITS.receipts, maxProfiles: REMOTE_TASK_LIMITS.profiles,
  leaseSeconds: REMOTE_TASK_LIMITS.leaseSeconds, providerPresenceSeconds: REMOTE_TASK_LIMITS.providerPresenceSeconds });
export const REMOTE_TASK_UPLOAD_HEADERS = ['X-PaperQuay-Remote-Attempt', 'X-PaperQuay-Remote-Fence'] as const;
export interface RemoteTaskRouteOptions {
  enabled?: boolean;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  repository?: RemoteTaskRepository;
}
const emptyQuery = { type: 'object', additionalProperties: false, properties: {} };
const emptyBody = { type: 'object', additionalProperties: false, properties: {} };
const params = { type: 'object', additionalProperties: false, required: ['id'],
  properties: { id: { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' } } };
function checked<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof RemoteTaskValidationError) throw new ApiError(error.code, error.code === 'REMOTE_TASK_ARTIFACT_LIMIT' ? 413 : 400);
    throw error;
  }
}
function currentIdentity(request: FastifyRequest) {
  if (!request.identity) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
  return request.identity;
}
function uploadLease(request: FastifyRequest): RemoteTaskLease {
  const attempt = request.headers['x-paperquay-remote-attempt']; const fence = request.headers['x-paperquay-remote-fence'];
  if (typeof attempt !== 'string' || !/^[1-9][0-9]{0,2}$/.test(attempt) || typeof fence !== 'string') throw new ApiError('REMOTE_TASK_INVALID');
  return checked(() => validateRemoteTaskLease({ attempt: Number(attempt), fence }));
}
function stream(content: Buffer) {
  function* chunks() { for (let i = 0; i < content.byteLength; i += 65536) yield content.subarray(i, i + 65536); }
  return Readable.from(chunks(), { objectMode: false, highWaterMark: 65536 });
}
/** Binary artifact routes have their own bounded parser; sync JSON limits stay unchanged. */
export async function registerRemoteTaskRoutes(app: FastifyInstance, options: RemoteTaskRouteOptions): Promise<void> {
  if (options.enabled && !options.repository) throw new ApiError('CONFIGURATION_INVALID', 500);
  const repository = () => {
    if (!options.enabled || !options.repository) throw new ApiError('REMOTE_TASKS_DISABLED', 503);
    return options.repository;
  };
  const activeAccounts = new Set<string>();
  const transfers = new WeakMap<FastifyRequest, { release(): void; working: boolean; ended: boolean }>();
  const acquire = (request: FastifyRequest, reply: FastifyReply) => {
    const identity = currentIdentity(request);
    const account = createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject])).digest('hex');
    if (activeAccounts.has(account) || activeAccounts.size >= 4) throw new ApiError('REMOTE_TASK_TRANSFER_BUSY', 429);
    if (request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded || request.raw.socket.destroyed) throw new ApiError('REMOTE_TASK_TRANSFER_CLOSED', 409);
    activeAccounts.add(account);
    let released = false;
    const transfer = { working: false, ended: false, release() {
      transfer.ended = true;
      if (released || transfer.working) return;
      released = true; clearTimeout(timer); activeAccounts.delete(account);
    } };
    const timer = setTimeout(() => { request.raw.destroy(); reply.raw.destroy(); transfer.release(); }, 45000);
    timer.unref();
    transfers.set(request, transfer);
    request.raw.once('aborted', () => transfer.release());
    reply.raw.once('close', () => transfer.release()); reply.raw.once('finish', () => transfer.release());
  };
  const during = async <T>(request: FastifyRequest, work: () => Promise<T>) => {
    const transfer = transfers.get(request);
    if (!transfer || transfer.ended) throw new ApiError('REMOTE_TASK_TRANSFER_CLOSED', 409);
    transfer.working = true;
    try { return await work(); }
    finally { transfer.working = false; if (transfer.ended) transfer.release(); }
  };
  await app.register(async (remote) => {
    remote.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: REMOTE_TASK_LIMITS.artifactBytes },
      (_request, body, done) => done(null, body));
    remote.addHook('onResponse', async (request) => { transfers.get(request)?.release(); });
    remote.addHook('onError', async (request) => { transfers.get(request)?.release(); });
    remote.addHook('onTimeout', async (request) => { transfers.get(request)?.release(); });
    const onRequest = [options.authenticate, async () => { repository(); }];
    const schema = { querystring: emptyQuery };
    const jobSchema = { params, querystring: emptyQuery };
    remote.get('/v1/remote-tasks/providers', { onRequest, schema }, (request) => repository().listProviders(currentIdentity(request)));
    remote.put<{ Body: { profiles: unknown } }>('/v1/remote-tasks/provider', { onRequest, bodyLimit: 8192,
      schema: { ...schema, body: { type: 'object', additionalProperties: false, required: ['profiles'], properties: { profiles: { type: 'array', maxItems: 8 } } } } },
    (request) => repository().publishProvider(currentIdentity(request), checked(() => validateRemoteTaskProfiles(request.body.profiles))));
    remote.delete('/v1/remote-tasks/provider', { onRequest, schema }, (request) => repository().withdrawProvider(currentIdentity(request)));
    remote.post('/v1/remote-tasks/jobs', { onRequest, bodyLimit: 4096, schema },
      (request) => repository().createTask(currentIdentity(request), checked(() => validateRemoteTaskRequest(request.body))));
    remote.get('/v1/remote-tasks/jobs', { onRequest, schema }, (request) => repository().listTasks(currentIdentity(request)));
    remote.get<{ Params: { id: string } }>('/v1/remote-tasks/requests/:id', { onRequest, schema: jobSchema },
      request => repository().lookupRequest(currentIdentity(request),request.params.id));
    remote.post<{ Params: { id: string } }>('/v1/remote-tasks/requests/:id/cancel', { onRequest, bodyLimit:512, schema: { ...jobSchema, body: emptyBody } },
      request => repository().cancelRequest(currentIdentity(request),request.params.id));
    remote.get<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id', { onRequest, schema: jobSchema },
      (request) => repository().getTask(currentIdentity(request), request.params.id));
    remote.delete<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id', { onRequest, schema: jobSchema },
      (request) => repository().deleteTask(currentIdentity(request), request.params.id));
    remote.post<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id/cancel', { onRequest, schema: { ...jobSchema, body: emptyBody } },
      (request) => repository().cancelTask(currentIdentity(request), request.params.id));
    remote.post<{ Params: { id: string }; Body: unknown }>('/v1/remote-tasks/jobs/:id/resume', { onRequest, bodyLimit:1024, schema: jobSchema },
      (request) => repository().resumeTask(currentIdentity(request), request.params.id, checked(()=>validateRemoteTaskResume(request.body))));
    remote.post('/v1/remote-tasks/provider/claim', { onRequest, schema: { ...schema, body: emptyBody } },
      (request) => repository().claimTask(currentIdentity(request)));
    remote.post<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id/heartbeat', { onRequest, bodyLimit: 512, schema: jobSchema },
      (request) => repository().heartbeatTask(currentIdentity(request), request.params.id, checked(() => validateRemoteTaskLease(request.body))));
    remote.post<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id/recovery-confirm', { onRequest, bodyLimit: 512, schema: jobSchema },
      (request) => repository().confirmRecovery(currentIdentity(request), request.params.id, checked(() => validateRemoteTaskLease(request.body))));
    remote.post<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id/fail', { onRequest, bodyLimit: 1024, schema: jobSchema },
      (request) => repository().failTask(currentIdentity(request), request.params.id, checked(() => validateRemoteTaskFailure(request.body))));
    remote.post<{ Params: { id: string }; Body: Buffer }>('/v1/remote-tasks/jobs/:id/complete', { bodyLimit: REMOTE_TASK_LIMITS.artifactBytes,
      schema: jobSchema, onRequest: [...onRequest, async (request, reply) => {
        checked(() => validateRemoteTaskId(request.params.id));
        if (Object.keys(request.query as object).length || request.headers['content-type']?.toLowerCase() !== 'application/octet-stream'
          || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) throw new ApiError('UNSUPPORTED_CONTENT_TYPE', 415);
        const length = request.headers['content-length'];
        if (length && (!/^[0-9]+$/.test(length) || Number(length) > REMOTE_TASK_LIMITS.artifactBytes)) throw new ApiError('REMOTE_TASK_ARTIFACT_LIMIT', 413);
        const lease = uploadLease(request); acquire(request, reply);
        await during(request, () => repository().prepareArtifactUpload(currentIdentity(request), request.params.id, lease));
      }] }, (request) => during(request, () => repository().completeTask(currentIdentity(request), request.params.id, uploadLease(request), request.body)));
    remote.get<{ Params: { id: string } }>('/v1/remote-tasks/jobs/:id/artifact', { schema: jobSchema,
      onRequest: [...onRequest, async (request, reply) => { acquire(request, reply); }] }, async (request, reply) => {
      const result = await during(request, () => repository().downloadArtifact(currentIdentity(request), request.params.id));
      reply.header('Content-Type', 'application/octet-stream').header('Content-Length', result.artifact.sizeBytes)
        .header('X-PaperQuay-Artifact-Digest', result.artifact.digest);
      return reply.send(stream(result.content));
    });
  });
}
