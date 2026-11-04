import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { REMOTE_RETRIEVAL_LIMITS as L, RemoteRetrievalValidationError, parseRemoteRetrievalJson, validateRemoteRetrievalRequest } from '../../packages/sync-core/src/remoteRetrieval.ts';
import type { RemoteRetrievalCapability } from '../../packages/sync-core/src/remoteRetrieval.ts';
import type { RemoteRetrievalRepository } from './remote-retrieval-store.ts';
import { ApiError } from './errors.ts';

export const REMOTE_RETRIEVAL_CAPABILITY: Readonly<RemoteRetrievalCapability> = Object.freeze({
  protocolVersion:1,mode:'lexical-v1',execution:'server',externalModelCalls:false,
  maxSources:L.sources,maxQueryBytes:L.queryBytes,maxTopK:L.topK,maxExcerptCharacters:L.excerptCharacters,
  maxRequestBytes:L.requestBytes,maxResultBytes:L.resultBytes,maxSourceBytes:L.sourceBytes,maxChunks:L.chunks,
  maxSourceCharacters:L.sourceCharacters,maxVectorElements:L.vectorElements,maxDurationMs:L.durationMs,
  maxRetained:L.retained,maxReceipts:L.receipts,maxAccountBytes:L.accountBytes,
});
export interface RemoteRetrievalRouteOptions {
  enabled?: boolean; repository?: RemoteRetrievalRepository;
  authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void>;
}
const uuid='^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';
const emptyQuery={type:'object',additionalProperties:false,properties:{}};
const idSchema={params:{type:'object',additionalProperties:false,required:['id'],properties:{id:{type:'string',pattern:uuid}}},querystring:emptyQuery};
function who(request:FastifyRequest){if(!request.identity)throw new ApiError('AUTHENTICATION_REQUIRED',401);return request.identity;}
function invalid(error:unknown):never{
  if(error instanceof RemoteRetrievalValidationError)throw new ApiError(error.code,error.code==='REMOTE_RETRIEVAL_LIMIT'?413:error.code==='REMOTE_RETRIEVAL_SOURCE_CHANGED'?409:400);
  throw error;
}
/** Independent capability. Existing artifacts remain queryable when computer execution is disabled. */
export async function registerRemoteRetrievalRoutes(app:FastifyInstance,options:RemoteRetrievalRouteOptions):Promise<void>{
  if(options.enabled&&!options.repository)throw new ApiError('CONFIGURATION_INVALID',500);
  const repository=()=>{if(!options.enabled||!options.repository)throw new ApiError('REMOTE_RETRIEVAL_DISABLED',503);return options.repository;};
  const active=new Set<string>();
  async function bounded<T>(request:FastifyRequest,reply:FastifyReply,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
    const identity=who(request),key=createHash('sha256').update(JSON.stringify([identity.issuer,identity.subject])).digest('hex');
    if(active.has(key)||active.size>=4)throw new ApiError('REMOTE_RETRIEVAL_BUSY',429);
    active.add(key);const controller=new AbortController(),abort=()=>controller.abort();
    request.raw.once('aborted',abort);reply.raw.once('close',abort);
    if(request.raw.aborted||reply.raw.destroyed)controller.abort();
    try{return await work(controller.signal);}finally{request.raw.removeListener('aborted',abort);reply.raw.removeListener('close',abort);active.delete(key);}
  }
  await app.register(async retrieval=>{
    retrieval.removeContentTypeParser('application/json');
    retrieval.addContentTypeParser('application/json',{parseAs:'buffer',bodyLimit:L.requestBytes},(_request,body,done)=>{
      try{done(null,parseRemoteRetrievalJson(body as Buffer));}catch(e){done(new ApiError(e instanceof RemoteRetrievalValidationError?e.code:'REMOTE_RETRIEVAL_INVALID',e instanceof RemoteRetrievalValidationError&&e.code==='REMOTE_RETRIEVAL_LIMIT'?413:400));}
    });
    const onRequest=[options.authenticate,async(request:FastifyRequest)=>{
      repository();if(request.method==='POST'&&(request.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/json'
        ||request.headers['content-encoding']&&request.headers['content-encoding']!=='identity'))throw new ApiError('UNSUPPORTED_CONTENT_TYPE',415);
    }];
    retrieval.get<{Querystring:{cursor?:string;limit?:string}}>('/v1/remote-retrieval/sources',{onRequest,schema:{querystring:{type:'object',additionalProperties:false,
      properties:{cursor:{type:'string',pattern:uuid},limit:{type:'string',pattern:'^[1-8]$'}}}}},(request,reply)=>bounded(request,reply,signal=>repository().listSources(who(request),
        {...(request.query.cursor===undefined?{}:{cursor:request.query.cursor}),...(request.query.limit===undefined?{}:{limit:Number(request.query.limit)})},{signal})));
    retrieval.get<{Params:{id:string}}>('/v1/remote-retrieval/sources/:id',{onRequest,schema:idSchema},(request,reply)=>bounded(request,reply,signal=>repository().source(who(request),request.params.id,{signal})));
    retrieval.post<{Body:unknown}>('/v1/remote-retrieval/requests',{onRequest,bodyLimit:L.requestBytes,schema:{querystring:emptyQuery}},async(request,reply)=>{
      let input;try{input=validateRemoteRetrievalRequest(request.body);}catch(e){invalid(e);}
      return bounded(request,reply,signal=>repository().retrieve(who(request),input,{signal}));
    });
    retrieval.get<{Params:{id:string}}>('/v1/remote-retrieval/requests/:id',{onRequest,schema:idSchema},request=>repository().lookup(who(request),request.params.id));
    retrieval.delete<{Params:{id:string}}>('/v1/remote-retrieval/requests/:id',{onRequest,schema:idSchema},request=>{
      if(request.body!==undefined)throw new ApiError('REMOTE_RETRIEVAL_INVALID',400);return repository().remove(who(request),request.params.id);
    });
  });
}
