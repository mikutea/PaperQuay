import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import Fastify, { LogController } from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import {
  ENTITY_TYPES, ENTITY_DATA_SCHEMAS, ISO_TIMESTAMP_PATTERN, UUID_PATTERN,
  PUSH_REQUEST_SCHEMA, PUSH_RESPONSE_SCHEMA, PUSH_RESULT_SCHEMA, PULL_RESPONSE_SCHEMA,
  SYNC_OPERATION_SCHEMA, SYNC_RECORD_SCHEMA, SYNC_LIMITS,
} from '../../packages/sync-core/src/index.ts';
import type { PushRequest } from '../../packages/sync-core/src/index.ts';
import type { TokenVerifier, VerifiedIdentity } from './auth.ts';
import { ApiError, isTransientDatabaseError } from './errors.ts';
import { SERVER_LIMITS } from './config.ts';
import type { ServerConfig } from './config.ts';
import type { DeviceRegistration, ResolveRequest, SyncRepository } from './types.ts';

declare module 'fastify' {
  interface FastifyRequest { identity: VerifiedIdentity | null }
}

interface AppOptions {
  config: ServerConfig;
  repository: SyncRepository;
  verifyToken: TokenVerifier;
  logger?: FastifyServerOptions['logger'];
  /** Used only by isolated tests, never set by process environment. */
  rateLimitEnabled?: boolean;
}

class PrivateLogController extends LogController {
  constructor() { super({ disableRequestLogging: true }); }
}

const uuid = { type: 'string', pattern: UUID_PATTERN };
const time = { type: 'string', pattern: ISO_TIMESTAMP_PATTERN, format: 'date-time' };
const nullableTime = { anyOf: [time, { type: 'null' }] };
const platforms = ['web', 'windows', 'macos', 'linux', 'ios', 'android'];
const deviceSchema = {
  type: 'object', additionalProperties: false,
  required: ['id', 'name', 'platform', 'createdAt', 'lastSeenAt', 'revokedAt'],
  properties: {
    id: uuid, name: { type: 'string', minLength: 1, maxLength: 80 }, platform: { enum: platforms },
    createdAt: time, lastSeenAt: time, revokedAt: nullableTime,
  },
};
const sessionSchema = {
  type: 'object', additionalProperties: false, required: ['accountId', 'device'],
  properties: { accountId: uuid, device: deviceSchema },
};
const idParams = { type: 'object', additionalProperties: false, properties: { id: uuid }, required: ['id'] };
const paginationSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    cursor: { type: 'string', minLength: 1, maxLength: SERVER_LIMITS.maxCursorLength },
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,3}$' },
  },
};
const conflictSchema = {
  type: 'object', additionalProperties: false,
  required: ['conflictId', 'entityType', 'entityId', 'createdAt', 'attemptedOperation', 'observedRecord', 'currentRecord'],
  properties: {
    conflictId: uuid, entityType: { enum: ENTITY_TYPES }, entityId: uuid, createdAt: time,
    attemptedOperation: SYNC_OPERATION_SCHEMA, observedRecord: SYNC_RECORD_SCHEMA, currentRecord: SYNC_RECORD_SCHEMA,
  },
};
const resolveBase = { opId: uuid, expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } };
const resolveSchema = {
  oneOf: [
    ...(['current', 'attempted'] as const).map((choice) => ({
      type: 'object', additionalProperties: false, required: ['opId', 'expectedRevision', 'choice'],
      properties: { ...resolveBase, choice: { const: choice } },
    })),
    ...(['put', 'restore', 'delete'] as const).map((mutation) => ({
      type: 'object', additionalProperties: false, required: ['opId', 'expectedRevision', 'choice', 'mutation', 'data'],
      properties: { ...resolveBase, choice: { const: 'merged' }, mutation: { const: mutation },
        data: mutation === 'delete' ? { type: 'null' } : { oneOf: Object.values(ENTITY_DATA_SCHEMAS) } },
    })),
  ],
};

function identity(request: FastifyRequest): VerifiedIdentity {
  if (!request.identity) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
  return request.identity;
}

function pageLimit(value: string | undefined, maximum: number): number {
  const number = value === undefined ? Math.min(100, maximum) : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > maximum) throw new ApiError('VALIDATION_FAILED');
  return number;
}

function rateLimitKey(request: FastifyRequest): string {
  if (request.identity) {
    // Only verified issuer/sub claims define the shared business budget. Sessions,
    // request bodies, routes, forwarding headers and source IPs cannot reset it.
    return 'account:' + createHash('sha256').update(JSON.stringify([
      request.identity.issuer, request.identity.subject,
    ])).digest('hex');
  }
  const address = isIP(request.ip) ? request.ip : request.raw.socket.remoteAddress ?? 'unknown';
  const client = normalizeIP(address, 128);
  const route = request.routeOptions.url;
  return (route === '/health/live' || route === '/health/ready' ? 'health:' : 'public:') + client;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { config, repository, verifyToken } = options;
  const app = Fastify({
    logger: options.logger ?? false,
    logController: new PrivateLogController(),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    bodyLimit: config.bodyLimitBytes,
    requestTimeout: 45000,
    connectionTimeout: 15000,
    keepAliveTimeout: 5000,
    trustProxy: config.trustedProxyIps.length ? config.trustedProxyIps : false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });
  app.decorateRequest('identity', null);
  await app.register(cors, {
    origin: config.allowedOrigins.length ? config.allowedOrigins : false,
    methods: ['GET', 'POST', 'DELETE'], allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: false, strictPreflight: true, maxAge: 600,
  });
  if (options.rateLimitEnabled !== false) {
    await app.register(rateLimit, {
      global: false,
      max: config.requestsPerMinute, timeWindow: 60000,
      errorResponseBuilder: () => new ApiError('RATE_LIMITED', 429),
      keyGenerator: rateLimitKey,
    });
  }
  // Reuse the same limiter/store across routes. Per-route plugin options create
  // separate child stores and would let callers multiply their business budget.
  const enforceRateLimit = options.rateLimitEnabled === false
    ? async (_request: FastifyRequest, _reply: FastifyReply) => undefined
    : app.rateLimit();
  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      request.identity = await verifyToken(request.headers.authorization);
    } catch (error) {
      await enforceRateLimit.call(app, request, reply);
      throw error;
    }
    await enforceRateLimit.call(app, request, reply);
  };
  app.setErrorHandler((error, request, reply) => {
    const raw = error as { statusCode?: number; validation?: unknown; code?: string };
    let code = 'INTERNAL_ERROR';
    let statusCode = 500;
    if (error instanceof ApiError) { code = error.code; statusCode = error.statusCode; }
    else if (raw.validation || raw.statusCode === 400) { code = 'VALIDATION_FAILED'; statusCode = 400; }
    else if (raw.statusCode === 413) { code = 'REQUEST_TOO_LARGE'; statusCode = 413; }
    else if (raw.statusCode === 415) { code = 'UNSUPPORTED_CONTENT_TYPE'; statusCode = 415; }
    else if (raw.statusCode === 429) { code = 'RATE_LIMITED'; statusCode = 429; }
    else if (isTransientDatabaseError(error)) { code = 'SERVICE_TEMPORARILY_UNAVAILABLE'; statusCode = 503; }
    if (statusCode >= 500) app.log.error({ code, requestId: request.id }, 'request failed');
    if (statusCode === 401) reply.header('WWW-Authenticate', 'Bearer realm="paperquay"');
    reply.code(statusCode).send({ error: { code, requestId: request.id } });
  });
  app.setNotFoundHandler({ preHandler: enforceRateLimit },
    (request, reply) => reply.code(404).send({ error: { code: 'NOT_FOUND', requestId: request.id } }));
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });

  app.get('/health/live', { onRequest: enforceRateLimit }, async () => ({ status: 'ok' }));
  app.get('/health/ready', { onRequest: enforceRateLimit }, async (_request, reply) => {
    const ready = await repository.ready();
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ready' : 'not_ready' });
  });
  app.get('/v1/capabilities', { onRequest: enforceRateLimit }, async () => ({
    protocolVersion: 1,
    entitySchemas: Object.fromEntries(ENTITY_TYPES.map((type) => [type, [1]])),
    deviceBinding: 'oidc-session',
    limits: {
      maxBatchOperations: SYNC_LIMITS.maxBatchOperations,
      maxPullRecords: SERVER_LIMITS.maxPullRecords,
      maxConflictRecords: SERVER_LIMITS.maxConflictRecords,
      maxRequestBytes: config.bodyLimitBytes,
      maxResponsePayloadBytes: config.responseLimitBytes,
      maxEntityBytes: config.entityLimitBytes,
      maxAccountEntities: SERVER_LIMITS.maxAccountEntities,
      maxAccountChanges: SERVER_LIMITS.maxAccountChanges,
      maxAccountConflicts: SERVER_LIMITS.maxAccountConflicts,
      maxAccountReceipts: SERVER_LIMITS.maxAccountReceipts,
      maxAccountRetainedBytes: config.maxAccountRetainedBytes,
      retainedRowOverheadBytes: SERVER_LIMITS.retainedRowOverheadBytes,
      maxActiveDeviceSessions: SERVER_LIMITS.maxDevices,
      maxRetainedDeviceSessions: SERVER_LIMITS.maxRetainedDeviceSessions,
    },
    pdfStorage: false,
    tombstoneRetention: 'no-pruning-in-m1',
  }));
  app.post<{ Body: DeviceRegistration }>('/v1/devices', {
    onRequest: authenticate,
    schema: {
      body: { type: 'object', additionalProperties: false, required: ['name', 'platform'], properties: {
        name: { type: 'string', minLength: 1, maxLength: 80, pattern: '^(?!\\s*$)[^\\x00-\\x1f\\x7f]+$' },
        platform: { enum: platforms },
      } },
      response: { 200: sessionSchema },
    },
  }, async (request) => repository.registerDevice(identity(request), request.body));
  app.get('/v1/me', { onRequest: authenticate, schema: { response: { 200: sessionSchema } } }, async (request) => repository.me(identity(request)));
  app.get('/v1/devices', {
    onRequest: authenticate,
    schema: { response: { 200: { type: 'object', additionalProperties: false, required: ['devices'], properties: {
      devices: { type: 'array', items: deviceSchema },
    } } } },
  }, async (request) => repository.listDevices(identity(request)));
  app.delete<{ Params: { id: string } }>('/v1/devices/:id', {
    onRequest: authenticate,
    schema: { params: idParams, response: { 200: { type: 'object', additionalProperties: false, required: ['revoked', 'deviceId'],
      properties: { revoked: { const: true }, deviceId: uuid } } } },
  }, async (request) => repository.revokeDevice(identity(request), request.params.id));
  app.post<{ Body: PushRequest }>('/v1/sync/push', {
    onRequest: authenticate, schema: { body: PUSH_REQUEST_SCHEMA, response: { 200: PUSH_RESPONSE_SCHEMA } },
  }, async (request) => repository.push(identity(request), request.body));
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/v1/sync/pull', {
    onRequest: authenticate, schema: { querystring: paginationSchema, response: { 200: PULL_RESPONSE_SCHEMA } },
  }, async (request) => repository.pull(identity(request), request.query.cursor, pageLimit(request.query.limit, SERVER_LIMITS.maxPullRecords)));
  app.get<{ Querystring: { cursor?: string; limit?: string } }>('/v1/conflicts', {
    onRequest: authenticate,
    schema: { querystring: paginationSchema, response: { 200: {
      type: 'object', additionalProperties: false, required: ['conflicts', 'nextCursor', 'hasMore'], properties: {
        conflicts: { type: 'array', items: conflictSchema }, nextCursor: { type: 'string' }, hasMore: { type: 'boolean' },
      },
    } } },
  }, async (request) => repository.listConflicts(identity(request), request.query.cursor, pageLimit(request.query.limit, SERVER_LIMITS.maxConflictRecords)));
  app.post<{ Params: { id: string }; Body: ResolveRequest }>('/v1/conflicts/:id/resolve', {
    onRequest: authenticate, schema: { params: idParams, body: resolveSchema, response: { 200: PUSH_RESULT_SCHEMA } },
  }, async (request) => repository.resolveConflict(identity(request), request.params.id, request.body));
  return app;
}
