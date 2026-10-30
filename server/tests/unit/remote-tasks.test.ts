import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { decodeRemoteIndexArtifact, decodeRemoteTaskJson, REMOTE_TASK_LIMITS, validateRemoteIndexArtifact,
  validateRemoteTaskFailure, validateRemoteTaskLease, validateRemoteTaskProfiles, validateRemoteTaskRequest, validateRemoteTaskRequestStatus } from '../../../packages/sync-core/src/remoteTasks.ts';
import type { RemoteIndexArtifact, RemoteTaskRequest } from '../../../packages/sync-core/src/remoteTasks.ts';
import { ApiError } from '../../src/errors.ts';
import { REMOTE_TASK_CAPABILITY, registerRemoteTaskRoutes } from '../../src/remote-tasks.ts';
import type { RemoteTaskRepository } from '../../src/remote-task-store.ts';
import { identity } from '../fixtures.ts';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const profile = () => ({ id: 'mineru-primary', revision: 1, digest: 'b'.repeat(64), kind: 'parse' as const, model: 'vlm' });
const request = (): RemoteTaskRequest => ({ requestId: randomUUID(), kind: 'parse', versionId: randomUUID(), providerDeviceId: randomUUID(),
  profileRef: { id: 'mineru-primary', revision: 1, digest: 'b'.repeat(64) } });
const lease = () => ({ attempt: 1, fence: randomUUID() });
function index(): RemoteIndexArtifact {
  const chunks = [{ id: 'chunk-0', pageIndex: 1, text: '可见数学 $x^2$\n第二行 😀', vector: [0.25, -0.5] }];
  return { format: 'paperquay-vector-index', version: 1, paperId: randomUUID(), attachmentVersionId: randomUUID(),
    pdf: { sha256: 'a'.repeat(64), sizeBytes: 100, pageCount: 2 }, parseDigest: 'c'.repeat(64), model: 'embedding-2',
    chunker: { id: 'parsed-v1', revision: 1, digest: 'd'.repeat(64) }, dimension: 2, chunkCount: 1, contentHash: hash(JSON.stringify(chunks)), chunks };
}
test('remote task request/profile/lease contracts are detached, closed and contain no transport authority', () => {
  const original = request(); const result = validateRemoteTaskRequest(original);
  assert.deepEqual(result, original); assert.notEqual(result.profileRef, original.profileRef);
  result.profileRef.id = 'changed'; assert.equal(original.profileRef.id, 'mineru-primary');
  for (const key of ['path', 'url', 'headers', 'key', 'endpoint', 'paperId', 'target']) {
    assert.throws(() => validateRemoteTaskRequest({ ...original, [key]: '/private' }), { code: 'REMOTE_TASK_INVALID' });
  }
  assert.throws(() => validateRemoteTaskRequest({ ...original, indexSourceDigest: 'a'.repeat(64) }));
  assert.throws(() => validateRemoteTaskRequest({ ...original, kind: 'index' }));
  assert.equal(validateRemoteTaskRequest({ ...original, kind: 'index', indexSourceDigest: 'a'.repeat(64) }).indexSourceDigest, 'a'.repeat(64));
  assert.throws(() => validateRemoteTaskRequest({ ...original, profileRef: { ...original.profileRef, endpoint: 'https://private.test' } }));
  const profiles = [profile()]; assert.deepEqual(validateRemoteTaskProfiles(profiles), profiles);
  assert.notEqual(validateRemoteTaskProfiles(profiles)[0], profiles[0]);
  assert.throws(() => validateRemoteTaskProfiles([{ ...profile(), headers: {} }]));
  assert.throws(() => validateRemoteTaskProfiles([profile(), profile()]));
  assert.throws(() => validateRemoteTaskProfiles(Array.from({ length: 9 }, (_, i) => ({ ...profile(), id: 'p' + i }))));
  assert.throws(() => validateRemoteTaskLease({ ...lease(), attempt: 0 }));
  assert.throws(() => validateRemoteTaskFailure({ ...lease(), code: 'Raw upstream secret' }));
  assert.equal(validateRemoteTaskFailure({ ...lease(), code: 'EXTERNAL_OUTCOME_UNKNOWN' }).code, 'EXTERNAL_OUTCOME_UNKNOWN');
  let invoked = false;
  assert.throws(() => validateRemoteTaskRequest(Object.defineProperty({ ...original }, 'kind', { enumerable: true, get() { invoked = true; return 'parse'; } })));
  assert.equal(invoked, false);
});
test('index artifact verifies content hash, dimensions, source identity and canonical UTF-8 without mutating input', async () => {
  const source = index(); const before = JSON.stringify(source);
  const parsed = await decodeRemoteIndexArtifact(Buffer.from(' \n' + before + '\n'));
  assert.deepEqual(parsed.document, source); assert.equal(parsed.digest, hash(before));
  assert.equal(Buffer.from(parsed.bytes).toString('utf8'), before); assert.equal(JSON.stringify(source), before);
  assert.notEqual(parsed.document.chunks[0].vector, source.chunks[0].vector);
  await assert.rejects(decodeRemoteIndexArtifact(Buffer.from(JSON.stringify({ ...source, contentHash: '0'.repeat(64) }))), { code: 'REMOTE_TASK_ARTIFACT_INVALID' });
  for (const changed of [
    { ...source, url: 'https://private.test' }, { ...source, dimension: 1 }, { ...source, chunkCount: 2 },
    { ...source, chunks: [{ ...source.chunks[0], vector: [NaN, 1] }] },
    { ...source, chunks: [{ ...source.chunks[0], pageIndex: 2 }] },
    { ...source, chunks: [{ ...source.chunks[0], text: ' ' }] },
    { ...source, chunks: [{ ...source.chunks[0], path: 'secret' }] },
    { ...source, chunks: [{ ...source.chunks[0], text: '\ud800' }] },
    { ...source, dimension: 4096, chunkCount: 1000 },
  ]) assert.throws(() => validateRemoteIndexArtifact(changed), { code: 'REMOTE_TASK_ARTIFACT_INVALID' });
});
test('index JSON rejects duplicate escaped keys, invalid UTF-8, BOM, deep input and oversized raw packages', () => {
  for (const text of ['{"x":1,"x":2}', '{"x":1,"\\u0078":2}', '{"outer":{"a":1,"a":2}}', '['.repeat(17) + '0' + ']'.repeat(17), '\ufeff{}']) {
    assert.throws(() => decodeRemoteTaskJson(Buffer.from(text)), { code: 'REMOTE_TASK_ARTIFACT_INVALID' });
  }
  assert.throws(() => decodeRemoteTaskJson(Uint8Array.of(0xc0, 0xaf)), { code: 'REMOTE_TASK_ARTIFACT_INVALID' });
  assert.throws(() => decodeRemoteTaskJson(new Uint8Array(REMOTE_TASK_LIMITS.artifactBytes + 1)), { code: 'REMOTE_TASK_ARTIFACT_LIMIT' });
});
async function fixture(enabled = true, overrides: Partial<RemoteTaskRepository> = {}) {
  const calls: string[] = []; const who = identity();
  const repository = new Proxy(overrides, { get(target, prop) {
    if (prop in target) return Reflect.get(target, prop);
    return async (...args: unknown[]) => { calls.push(String(prop)); return { received: args.at(-1) instanceof Uint8Array ? 'binary' : args.at(-1) }; };
  } }) as RemoteTaskRepository;
  const app = Fastify({ logger: false, bodyLimit: 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.decorateRequest('identity', null);
  app.setErrorHandler((error, _request, reply) => {
    const e = error as ApiError; reply.code(e.statusCode ?? 500).send({ error: { code: e.code } });
  });
  await registerRemoteTaskRoutes(app, { enabled, repository, authenticate: async (req) => {
    if (req.headers.authorization !== 'Bearer synthetic') throw new ApiError('AUTHENTICATION_REQUIRED', 401);
    req.identity = who;
  } });
  return { app, calls, headers: { authorization: 'Bearer synthetic' }, who };
}
test('remote routes default off, require authentication and expose bounded capability data', async (t) => {
  const f = await fixture(false); t.after(() => f.app.close());
  assert.equal((await f.app.inject('/v1/remote-tasks/jobs')).statusCode, 401);
  const disabled = await f.app.inject({ method: 'GET', url: '/v1/remote-tasks/jobs', headers: f.headers });
  assert.equal(disabled.statusCode, 503); assert.equal(disabled.json().error.code, 'REMOTE_TASKS_DISABLED'); assert.deepEqual(f.calls, []);
  const empty = Fastify(); t.after(() => empty.close());
  await assert.rejects(registerRemoteTaskRoutes(empty, { enabled: true, authenticate: async () => {} }), { code: 'CONFIGURATION_INVALID' });
  assert.equal(REMOTE_TASK_CAPABILITY.maxArtifactBytes, 16 * 1024 * 1024);
  assert.equal(REMOTE_TASK_CAPABILITY.maxActive, 1); assert.equal(REMOTE_TASK_CAPABILITY.transport, 'persistent-jobs-v1');
});
test('routes reject unknown job/profile payload fields and forward only validated detached DTOs', async (t) => {
  const f = await fixture(); t.after(() => f.app.close());
  const original = request();
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/remote-tasks/jobs', headers: f.headers, payload: { ...original, path: '/secret' } })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'PUT', url: '/v1/remote-tasks/provider', headers: f.headers, payload: { profiles: [{ ...profile(), key: 'secret' }] } })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/remote-tasks/jobs', headers: f.headers, payload: original })).statusCode, 200);
  assert.deepEqual(f.calls, ['createTask']);
  assert.equal((await f.app.inject({ method: 'POST', url: '/v1/remote-tasks/jobs/' + randomUUID() + '/heartbeat', headers: f.headers, payload: { ...lease(), path: '/secret' } })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'GET', url: '/v1/remote-tasks/jobs?accountId=' + randomUUID(), headers: f.headers })).statusCode, 400);
});
test('binary completion authenticates its lease before the body and keeps sync JSON limits unchanged', async (t) => {
  const denied = await fixture(true, { prepareArtifactUpload: async () => { throw new ApiError('REMOTE_TASK_LEASE_CHANGED', 409); } });
  const accepted = await fixture(); t.after(async () => { await denied.app.close(); await accepted.app.close(); });
  const id = randomUUID(); const attempt = lease();
  const headers = { ...accepted.headers, 'content-type': 'application/octet-stream', 'x-paperquay-remote-attempt': '1', 'x-paperquay-remote-fence': attempt.fence };
  const url = '/v1/remote-tasks/jobs/' + id + '/complete';
  assert.equal((await denied.app.inject({ method: 'POST', url, headers, payload: Buffer.alloc(2048) })).statusCode, 409);
  assert.deepEqual(denied.calls, []);
  const response = await accepted.app.inject({ method: 'POST', url, headers, payload: Buffer.alloc(2048) });
  assert.equal(response.statusCode, 200); assert.equal(response.json().received, 'binary');
  assert.deepEqual(accepted.calls, ['prepareArtifactUpload', 'completeTask']);
  assert.equal((await accepted.app.inject({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, payload: '{}' })).statusCode, 415);
  assert.equal((await accepted.app.inject({ method: 'POST', url, headers: { ...headers, 'content-encoding': 'gzip' }, payload: Buffer.alloc(1) })).statusCode, 415);
  assert.equal((await accepted.app.inject({ method: 'POST', url, headers: { ...headers, 'content-length': String(REMOTE_TASK_LIMITS.artifactBytes + 1) }, payload: Buffer.alloc(1) })).statusCode, 413);
});
test('binary transfer admission is bounded per account until in-flight work settles', async (t) => {
  let release!: () => void; let admitted!: () => void;
  const started = new Promise<void>((resolve) => { admitted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(true, { prepareArtifactUpload: async () => { admitted(); await gate; } }); t.after(() => f.app.close());
  const headers = { ...f.headers, 'content-type': 'application/octet-stream', 'x-paperquay-remote-attempt': '1', 'x-paperquay-remote-fence': randomUUID() };
  const url = '/v1/remote-tasks/jobs/' + randomUUID() + '/complete';
  const first = f.app.inject({ method: 'POST', url, headers, payload: Buffer.from('{}') }); await started;
  assert.equal((await f.app.inject({ method: 'POST', url, headers, payload: Buffer.from('{}') })).statusCode, 429);
  release(); assert.equal((await first).statusCode, 200);
  assert.equal((await f.app.inject({ method: 'POST', url, headers, payload: Buffer.from('{}') })).statusCode, 200);
});


test('request-ID routes authenticate, reject private payloads and use validated account-scoped IDs',async t=>{
 const id=randomUUID(),seen:string[]=[];
 const f=await fixture(true,{lookupRequest:async(who,id)=>{assert.deepEqual(who,f.who);seen.push('lookup:'+id);return{requestId:id,status:'absent',task:null};},
   cancelRequest:async(who,id)=>{assert.deepEqual(who,f.who);seen.push('cancel:'+id);return{requestId:id,status:'cancelled',task:null};}});t.after(()=>f.app.close());
 assert.equal((await f.app.inject('/v1/remote-tasks/requests/'+id)).statusCode,401);
 assert.equal((await f.app.inject({method:'POST',url:'/v1/remote-tasks/requests/'+id+'/cancel',headers:f.headers,payload:{endpoint:'https://private.test'}})).statusCode,400);
 assert.equal((await f.app.inject({method:'GET',url:'/v1/remote-tasks/requests/not-a-uuid',headers:f.headers})).statusCode,400);
 const status=await f.app.inject({method:'GET',url:'/v1/remote-tasks/requests/'+id,headers:f.headers});assert.deepEqual(status.json(),{requestId:id,status:'absent',task:null});
 const cancelled=await f.app.inject({method:'POST',url:'/v1/remote-tasks/requests/'+id+'/cancel',headers:f.headers,payload:{}});assert.deepEqual(cancelled.json(),{requestId:id,status:'cancelled',task:null});
 assert.deepEqual(seen,['lookup:'+id,'cancel:'+id]);
});
test('request status contracts reject mismatched status/task pairs, accessors and transport authority',()=>{
 const status={requestId:randomUUID(),status:'absent',task:null};assert.deepEqual(validateRemoteTaskRequestStatus(status),status);
 for(const changed of [{...status,status:'known'},{...status,status:'unknown'},{...status,task:{}},{...status,token:'private'}])assert.throws(()=>validateRemoteTaskRequestStatus(changed));
 let invoked=false;assert.throws(()=>validateRemoteTaskRequestStatus(Object.defineProperty({...status},'status',{enumerable:true,get(){invoked=true;return'absent';}})));assert.equal(invoked,false);
});
