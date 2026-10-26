import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { ISO_TIMESTAMP_PATTERN, UUID_PATTERN } from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from './auth.ts';
import { SERVER_LIMITS } from './config.ts';
import { ApiError } from './errors.ts';
import type { CloudPdfRepository, SyncRepository } from './types.ts';

const uuid = { type: 'string', pattern: UUID_PATTERN };
const params = { type: 'object', additionalProperties: false, required: ['id'], properties: { id: uuid } };
const querystring = { type: 'object', additionalProperties: false, properties: {} };
const quota = {
  type: 'object', additionalProperties: false, required: ['usedBytes', 'maxBytes', 'usedCopies', 'maxCopies'],
  properties: {
    usedBytes: { type: 'integer', minimum: 0, maximum: SERVER_LIMITS.cloudPdfMaxConfiguredAccountBytes },
    maxBytes: { type: 'integer', minimum: 1, maximum: SERVER_LIMITS.cloudPdfMaxConfiguredAccountBytes },
    usedCopies: { type: 'integer', minimum: 0, maximum: SERVER_LIMITS.cloudPdfMaxCopies },
    maxCopies: { const: SERVER_LIMITS.cloudPdfMaxCopies },
  },
};
const copy = {
  type: 'object', additionalProperties: false,
  required: ['attachmentVersionId', 'paperId', 'sha256', 'sizeBytes', 'fileName', 'createdAt', 'available'],
  properties: {
    attachmentVersionId: uuid, paperId: uuid,
    sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    sizeBytes: { type: 'integer', minimum: 1, maximum: SERVER_LIMITS.cloudPdfMaxFileBytes },
    fileName: { type: 'string', minLength: 1, maxLength: 255 },
    createdAt: { type: 'string', pattern: ISO_TIMESTAMP_PATTERN, format: 'date-time' },
    available: { type: 'boolean' },
  },
};
const statusResponse = { type: 'object', additionalProperties: false, required: ['copy', 'quota'],
  properties: { copy: { anyOf: [copy, { type: 'null' }] }, quota } };
const idPattern = new RegExp(UUID_PATTERN);

function currentIdentity(request: FastifyRequest): VerifiedIdentity {
  if (!request.identity) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
  return request.identity;
}

function downloadBody(content: Buffer): Readable {
  // The full bounded bytea still resides in memory and holds a transfer slot.
  // Small writes let socket backpressure apply instead of enqueueing one 64 MiB
  // write into the OS (which can report finish before a paused peer reads it).
  function* chunks() {
    for (let offset = 0; offset < content.byteLength; offset += 64 * 1024) {
      yield content.subarray(offset, Math.min(content.byteLength, offset + 64 * 1024));
    }
  }
  return Readable.from(chunks(), { objectMode: false, highWaterMark: 64 * 1024 });
}

interface TransferLease { ended: boolean; working: boolean; released: boolean; finish(): void; releaseIfFinished(): void }
interface CloudRouteOptions {
  enabled: boolean;
  repository?: CloudPdfRepository;
  sessions: SyncRepository;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  /** Isolated socket tests only; normal startup always uses the 45 second deadline. */
  transferTimeoutMs?: number;
}

/** Separate binary routes leave the existing sync JSON schemas and body limit unchanged. */
export async function registerCloudPdfRoutes(app: FastifyInstance, options: CloudRouteOptions): Promise<void> {
  if (options.enabled && !options.repository) throw new ApiError('CONFIGURATION_INVALID', 500);
  const transferTimeoutMs = options.transferTimeoutMs ?? 45000;
  if (!Number.isSafeInteger(transferTimeoutMs) || transferTimeoutMs < 1 || transferTimeoutMs > 45000) throw new ApiError('CONFIGURATION_INVALID', 500);
  const activeAccounts = new Set<string>();
  const leases = new WeakMap<FastifyRequest, TransferLease>();
  const admissions = new WeakMap<FastifyRequest, { generation: string }>();
  const repository = () => {
    if (!options.enabled || !options.repository) throw new ApiError('CLOUD_PDF_STORAGE_DISABLED', 503);
    return options.repository;
  };
  const acquire = (request: FastifyRequest, reply: FastifyReply, accountId: string) => {
    // Async authentication/DB preflight can outlive a disconnected client.
    // IncomingMessage.destroyed alone also covers normally consumed requests;
    // only a terminated response/connection or an actual abort closes admission.
    const closed = () => request.raw.aborted || reply.raw.destroyed || reply.raw.writableEnded || request.raw.socket.destroyed;
    if (closed()) throw new ApiError('CLOUD_PDF_CHANGED', 409);
    if (activeAccounts.has(accountId) || activeAccounts.size >= SERVER_LIMITS.cloudPdfMaxTransfers) {
      reply.header('Retry-After', '1');
      throw new ApiError('CLOUD_PDF_TRANSFER_BUSY', 429);
    }
    activeAccounts.add(accountId);
    const lease: TransferLease = {
      ended: false, working: false, released: false,
      finish() { lease.ended = true; lease.releaseIfFinished(); },
      releaseIfFinished() {
        if (!lease.ended || lease.working || lease.released) return;
        lease.released = true;
        clearTimeout(deadline);
        activeAccounts.delete(accountId);
      },
    };
    // request.raw.close can mean the request body finished, not the response.
    reply.raw.once('finish', () => lease.finish());
    reply.raw.once('close', () => lease.finish());
    reply.raw.once('error', () => lease.finish());
    request.raw.once('aborted', () => lease.finish());
    const deadline = setTimeout(() => {
      // A request deadline bounds both slow uploads and slow download sockets.
      // If a DB transaction is still running, retain its slot until it settles.
      request.raw.destroy();
      reply.raw.destroy();
      lease.finish();
    }, transferTimeoutMs);
    deadline.unref();
    leases.set(request, lease);
    if (closed()) {
      lease.finish();
      throw new ApiError('CLOUD_PDF_CHANGED', 409);
    }
  };
  const duringTransfer = async <T>(request: FastifyRequest, action: () => Promise<T>): Promise<T> => {
    const lease = leases.get(request);
    if (!lease || lease.ended) throw new ApiError('CLOUD_PDF_CHANGED', 409);
    lease.working = true;
    try { return await action(); }
    finally { lease.working = false; lease.releaseIfFinished(); }
  };
  await app.register(async (cloud) => {
    cloud.addContentTypeParser('application/pdf', { parseAs: 'buffer', bodyLimit: SERVER_LIMITS.cloudPdfMaxFileBytes },
      (_request, body, done) => done(null, body));
    cloud.addHook('onResponse', async (request) => { leases.get(request)?.finish(); });
    cloud.addHook('onRequestAbort', async (request) => { leases.get(request)?.finish(); });
    cloud.addHook('onTimeout', async (request) => { leases.get(request)?.finish(); });
    const onRequest = [options.authenticate, async () => { repository(); }];
    cloud.get('/v1/cloud-pdfs', {
      onRequest, schema: { querystring, response: { 200: { type: 'object', additionalProperties: false,
        required: ['copies', 'quota'], properties: { copies: { type: 'array', maxItems: SERVER_LIMITS.cloudPdfMaxCopies, items: copy }, quota } } } },
    }, async (request) => repository().listCloudPdfs(currentIdentity(request)));
    cloud.get<{ Params: { id: string } }>('/v1/cloud-pdfs/:id', {
      onRequest, schema: { params, querystring, response: { 200: statusResponse } },
    }, async (request) => repository().getCloudPdf(currentIdentity(request), request.params.id));
    cloud.put<{ Params: { id: string }; Body: Buffer }>('/v1/cloud-pdfs/:id', {
      bodyLimit: SERVER_LIMITS.cloudPdfMaxFileBytes,
      onRequest: [...onRequest, async (request, reply) => {
        if (!idPattern.test(request.params.id) || Object.keys(request.query as object).length) throw new ApiError('VALIDATION_FAILED');
        if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/pdf'
          || (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity')) {
          throw new ApiError('UNSUPPORTED_CONTENT_TYPE', 415);
        }
        const target = await repository().prepareCloudPdfUpload(currentIdentity(request), request.params.id);
        const length = request.headers['content-length'];
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) !== target.sizeBytes)) {
          throw new ApiError(Number(length) > SERVER_LIMITS.cloudPdfMaxFileBytes ? 'REQUEST_TOO_LARGE' : 'PDF_INTEGRITY_MISMATCH',
            Number(length) > SERVER_LIMITS.cloudPdfMaxFileBytes ? 413 : 422);
        }
        acquire(request, reply, target.accountId);
        admissions.set(request, { generation: target.generation });
      }],
      schema: { params, querystring, response: { 200: { type: 'object', additionalProperties: false,
        required: ['copy', 'replayed', 'quota'], properties: { copy, replayed: { type: 'boolean' }, quota } } } },
    }, async (request) => duringTransfer(request, async () => {
      if (!Buffer.isBuffer(request.body)) throw new ApiError('UNSUPPORTED_CONTENT_TYPE', 415);
      return repository().putCloudPdf(currentIdentity(request), request.params.id, request.body, admissions.get(request)!.generation);
    }));
    cloud.get<{ Params: { id: string } }>('/v1/cloud-pdfs/:id/content', {
      onRequest: [...onRequest, async (request, reply) => {
        const session = await options.sessions.me(currentIdentity(request));
        acquire(request, reply, session.accountId);
      }], schema: { params, querystring },
    }, async (request, reply) => duringTransfer(request, async () => {
      const result = await repository().downloadCloudPdf(currentIdentity(request), request.params.id);
      return reply.type('application/pdf').header('Content-Length', result.content.byteLength)
        .header('Content-Disposition', "attachment; filename=\"paper.pdf\"; filename*=UTF-8''" + encodeURIComponent(Buffer.from(result.copy.fileName, 'utf8').toString('utf8'))
          .replace(/['()*]/g, (character) => '%' + character.charCodeAt(0).toString(16).toUpperCase()))
        .header('Accept-Ranges', 'none').send(downloadBody(result.content));
    }));
    cloud.delete<{ Params: { id: string } }>('/v1/cloud-pdfs/:id', {
      onRequest, schema: { params, querystring, response: { 200: { type: 'object', additionalProperties: false,
        required: ['attachmentVersionId', 'deleted', 'quota'], properties: { attachmentVersionId: uuid, deleted: { type: 'boolean' }, quota } } } },
    }, async (request) => repository().deleteCloudPdf(currentIdentity(request), request.params.id));
  });
}
