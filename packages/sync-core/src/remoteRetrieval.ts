import { canonicalJson } from './validation.ts';
import { inspectModelInferenceJson, parseModelInferenceJson, ModelInferenceValidationError } from './modelInference.ts';
import { validateRemoteProfileRef, validateRemoteTaskTarget } from './remoteTasks.ts';
import type { RemoteIndexArtifact, RemoteProfileRef, RemoteTaskTarget } from './remoteTasks.ts';

/** This protocol retrieves existing, explicitly selected index text. It never calls an embedding or chat provider. */
export const REMOTE_RETRIEVAL_LIMITS = Object.freeze({
  protocolVersion: 1, sources: 8, queryBytes: 4096, queryCharacters: 2048, terms: 64, topK: 24,
  excerptCharacters: 1800, requestBytes: 32 * 1024, resultBytes: 192 * 1024,
  sourceBytes: 16 * 1024 * 1024, chunks: 10000, sourceCharacters: 2000000, vectorElements: 2000000,
  durationMs: 10000, retained: 64, receipts: 256, accountBytes: 8 * 1024 * 1024,
});
export interface RemoteRetrievalSource {
  taskId: string; artifactDigest: string; artifactBytes: number; target: RemoteTaskTarget;
  parseDigest: string; model: string; dimension: number; chunker: RemoteProfileRef;
  chunkCount: number; contentHash: string; textCharacters: number;
}
export interface RemoteRetrievalRequest {
  version: 1; requestId: string; mode: 'lexical-v1'; query: string; topK: number; sources: RemoteRetrievalSource[];
}
export interface RemoteRetrievalEvidence {
  id: string; sourceIndex: number; chunkIndex: number; chunkId: string; pageIndex: number;
  text: string; excerptStart: number; fullTextLength: number; chunkDigest: string; excerptDigest: string;
  /** Number of distinct query terms in the full chunk, not a semantic similarity or correctness probability. */
  score: number; matchedTerms: string[];
}
export interface RemoteRetrievalResult {
  version: 1; mode: 'lexical-v1'; requestDigest: string; terms: string[]; evidence: RemoteRetrievalEvidence[];
  stats: { scannedChunks: number; sourceCharacters: number; matchingChunks: number; omittedMatches: number; excerptCharacters: number; omittedCharacters: number };
}
export interface RemoteRetrievalReceipt {
  version: 1; request: RemoteRetrievalRequest; requestDigest: string; result: RemoteRetrievalResult; resultDigest: string; createdAt: string;
}
export interface RemoteRetrievalStatus {
  requestId: string; status: 'absent' | 'complete' | 'removed'; requestDigest: string | null; receipt: RemoteRetrievalReceipt | null;
}
export interface RemoteRetrievalSourcesPage { sources: RemoteRetrievalSource[]; nextCursor: string | null; hasMore: boolean }
export interface RemoteRetrievalCapability {
  protocolVersion: 1; mode: 'lexical-v1'; execution: 'server'; externalModelCalls: false;
  maxSources: number; maxQueryBytes: number; maxTopK: number; maxExcerptCharacters: number;
  maxRequestBytes: number; maxResultBytes: number; maxSourceBytes: number; maxChunks: number;
  maxSourceCharacters: number; maxVectorElements: number; maxDurationMs: number;
  maxRetained: number; maxReceipts: number; maxAccountBytes: number;
}
export class RemoteRetrievalValidationError extends Error {
  readonly code: 'REMOTE_RETRIEVAL_INVALID' | 'REMOTE_RETRIEVAL_LIMIT' | 'REMOTE_RETRIEVAL_SOURCE_CHANGED';
  constructor(code: RemoteRetrievalValidationError['code'] = 'REMOTE_RETRIEVAL_INVALID') { super(code); this.name = 'RemoteRetrievalValidationError'; this.code = code; }
}
const L = REMOTE_RETRIEVAL_LIMITS, encoder = new TextEncoder();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function invalid(): never { throw new RemoteRetrievalValidationError(); }
function limit(): never { throw new RemoteRetrievalValidationError('REMOTE_RETRIEVAL_LIMIT'); }
function changed(): never { throw new RemoteRetrievalValidationError('REMOTE_RETRIEVAL_SOURCE_CHANGED'); }
function inspect(value: unknown, max: number): void {
  try { inspectModelInferenceJson(value, max); }
  catch (e) { if (e instanceof ModelInferenceValidationError && e.code === 'MODEL_INFERENCE_LIMIT') limit(); invalid(); }
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).length !== keys.length || keys.some(k => !Object.hasOwn(descriptors, k))
    || Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) invalid();
  return value as Record<string, unknown>;
}
function int(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) invalid(); if (Number(value) > max) limit(); return Number(value);
}
function text(value: unknown, max: number, required = true): string {
  if (typeof value !== 'string' || required && !value.trim() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) invalid();
  if (value.length > max) limit(); try { encodeURIComponent(value); } catch { invalid(); } return value;
}
function hash(value: unknown): string { if (typeof value !== 'string' || !HASH.test(value)) invalid(); return value; }
export function remoteRetrievalId(value: unknown): string { if (typeof value !== 'string' || !UUID.test(value)) invalid(); return value; }
function array(value: unknown, max: number): unknown[] { if (!Array.isArray(value)) invalid(); if (value.length > max) limit(); return value; }
function stamp(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) invalid(); return value;
}
export function parseRemoteRetrievalJson(bytes: Uint8Array, max = L.requestBytes): unknown {
  try { return parseModelInferenceJson(bytes, max); }
  catch (e) { if (e instanceof ModelInferenceValidationError && e.code === 'MODEL_INFERENCE_LIMIT') limit(); invalid(); }
}
export async function remoteRetrievalDigest(value: unknown): Promise<string> {
  inspect(value, L.resultBytes + L.requestBytes + 8192);
  const bytes = encoder.encode(canonicalJson(value)); return bytesDigest(bytes);
}
async function bytesDigest(bytes: Uint8Array): Promise<string> {
  const result = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
  return Array.from(new Uint8Array(result), n => n.toString(16).padStart(2, '0')).join('');
}
/** Lowercase Latin runs and overlapping CJK bigrams. No stop-word or semantic expansion is hidden from the preview. */
export function remoteRetrievalTerms(query: string): string[] {
  text(query,L.queryCharacters);if(encoder.encode(query).length>L.queryBytes)limit();
  const terms = new Set<string>();
  for (const run of query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let other = '', cjk = '';
    const flushOther = () => { if (other.length >= 2) terms.add(other); other = ''; };
    const flushCjk = () => { const chars = Array.from(cjk); if (chars.length === 1) terms.add(chars[0]); else for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i] + chars[i + 1]); cjk = ''; };
    for (const char of run) { if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(char)) { flushOther(); cjk += char; } else { flushCjk(); other += char; } }
    flushOther(); flushCjk(); if (terms.size > L.terms) limit();
  }
  if (!terms.size) invalid(); if (terms.size > L.terms) limit(); return [...terms];
}
export function validateRemoteRetrievalSourcesPage(value: unknown): RemoteRetrievalSourcesPage {
  inspect(value,64*1024);const p=object(value,['sources','nextCursor','hasMore']);
  const sources=array(p.sources,L.sources).map(validateRemoteRetrievalSource);
  if(new Set(sources.map(s=>s.taskId)).size!==sources.length||typeof p.hasMore!=='boolean')invalid();
  const nextCursor=p.nextCursor===null?null:remoteRetrievalId(p.nextCursor);if(p.hasMore!==(nextCursor!==null))invalid();
  return{sources,nextCursor,hasMore:p.hasMore};
}
export function validateRemoteRetrievalSource(value: unknown): RemoteRetrievalSource {
  inspect(value, 8192);
  const s = object(value, ['taskId','artifactDigest','artifactBytes','target','parseDigest','model','dimension','chunker','chunkCount','contentHash','textCharacters']);
  let target: RemoteTaskTarget, chunker: RemoteProfileRef;
  try { target = validateRemoteTaskTarget(s.target); chunker = validateRemoteProfileRef(s.chunker); } catch { invalid(); }
  if (target.pageCount === null) invalid();
  const source = { taskId: remoteRetrievalId(s.taskId), artifactDigest: hash(s.artifactDigest), artifactBytes: int(s.artifactBytes, 1, L.sourceBytes),
    target, parseDigest: hash(s.parseDigest), model: text(s.model, 128), dimension: int(s.dimension, 1, 4096), chunker,
    chunkCount: int(s.chunkCount, 1, L.chunks), contentHash: hash(s.contentHash), textCharacters: int(s.textCharacters, 1, L.sourceCharacters) };
  if (source.dimension * source.chunkCount > L.vectorElements) limit(); return source;
}
export function validateRemoteRetrievalRequest(value: unknown): RemoteRetrievalRequest {
  inspect(value, L.requestBytes); const r = object(value, ['version','requestId','mode','query','topK','sources']);
  if (r.version !== 1 || r.mode !== 'lexical-v1') invalid(); const query = text(r.query, L.queryCharacters);
  if (encoder.encode(query).length > L.queryBytes) limit(); remoteRetrievalTerms(query);
  const sources = array(r.sources, L.sources).map(validateRemoteRetrievalSource);
  if (!sources.length || new Set(sources.map(s => s.taskId)).size !== sources.length
    || new Set(sources.map(s => s.target.attachmentVersionId)).size !== sources.length) invalid();
  if (sources.reduce((n,s) => n+s.artifactBytes, 0) > L.sourceBytes || sources.reduce((n,s) => n+s.chunkCount, 0) > L.chunks
    || sources.reduce((n,s) => n+s.textCharacters, 0) > L.sourceCharacters || sources.reduce((n,s) => n+s.dimension*s.chunkCount, 0) > L.vectorElements) limit();
  return { version: 1, requestId: remoteRetrievalId(r.requestId), mode: 'lexical-v1', query, topK: int(r.topK, 1, L.topK), sources };
}
export function validateRemoteRetrievalCapability(value: unknown): RemoteRetrievalCapability {
  inspect(value, 4096);
  const keys = ['protocolVersion','mode','execution','externalModelCalls','maxSources','maxQueryBytes','maxTopK','maxExcerptCharacters','maxRequestBytes','maxResultBytes','maxSourceBytes','maxChunks','maxSourceCharacters','maxVectorElements','maxDurationMs','maxRetained','maxReceipts','maxAccountBytes'];
  const c = object(value, keys); if (c.protocolVersion !== 1 || c.mode !== 'lexical-v1' || c.execution !== 'server' || c.externalModelCalls !== false) invalid();
  const limits = { maxSources:L.sources,maxQueryBytes:L.queryBytes,maxTopK:L.topK,maxExcerptCharacters:L.excerptCharacters,maxRequestBytes:L.requestBytes,maxResultBytes:L.resultBytes,maxSourceBytes:L.sourceBytes,maxChunks:L.chunks,maxSourceCharacters:L.sourceCharacters,maxVectorElements:L.vectorElements,maxDurationMs:L.durationMs,maxRetained:L.retained,maxReceipts:L.receipts,maxAccountBytes:L.accountBytes };
  for (const [key,max] of Object.entries(limits)) int(c[key],1,max);
  return structuredClone(c) as unknown as RemoteRetrievalCapability;
}
/** Artifact bytes were already decoded and hashed by the source adapter; this closes every manifest binding before searching. */
export function assertRemoteRetrievalArtifact(source: RemoteRetrievalSource, artifact: RemoteIndexArtifact): void {
  if (artifact.paperId !== source.target.paperId || artifact.attachmentVersionId !== source.target.attachmentVersionId
    || artifact.pdf.sha256 !== source.target.sha256 || artifact.pdf.sizeBytes !== source.target.sizeBytes || artifact.pdf.pageCount !== source.target.pageCount
    || artifact.parseDigest !== source.parseDigest || artifact.model !== source.model || artifact.dimension !== source.dimension
    || canonicalJson(artifact.chunker) !== canonicalJson(source.chunker) || artifact.chunkCount !== source.chunkCount
    || artifact.contentHash !== source.contentHash || artifact.chunks.length !== source.chunkCount
    || artifact.chunks.reduce((n,c) => n+c.text.length,0) !== source.textCharacters) changed();
}
function evidenceId(sourceIndex: number, chunkIndex: number): string { return 'R'+(sourceIndex+1)+'C'+(chunkIndex+1); }
function excerpt(value: string, firstMatch: number): { text: string; start: number } {
  let start = Math.max(0, firstMatch - 160); start = Math.min(start, Math.max(0, value.length - L.excerptCharacters));
  if (start > 0 && /[\udc00-\udfff]/.test(value[start])) start--;
  let end = Math.min(value.length,start+L.excerptCharacters); if (end < value.length && /[\ud800-\udbff]/.test(value[end-1])) end--;
  return {text:value.slice(start,end),start};
}
function lowerWithOffsets(value: string): { lower: string; offsets: number[] } {
  let lower = '', position = 0; const offsets: number[] = [];
  for (const char of value) { const part = char.toLowerCase(); lower += part; for (let i=0;i<part.length;i++) offsets.push(position); position += char.length; }
  return {lower,offsets};
}
export async function runRemoteLexicalRetrieval(input: RemoteRetrievalRequest, artifacts: readonly RemoteIndexArtifact[],
  options: { check?(): void; yield?(): Promise<void> } = {}): Promise<RemoteRetrievalResult> {
  const request=validateRemoteRetrievalRequest(input),terms=remoteRetrievalTerms(request.query); options.check?.();
  if (artifacts.length !== request.sources.length) changed();
  const ranked: {sourceIndex:number;chunkIndex:number;score:number;matchedTerms:string[];firstMatch:number}[]=[];
  let scanned=0,characters=0;
  for (const [sourceIndex,source] of request.sources.entries()) {
    const artifact=artifacts[sourceIndex]; assertRemoteRetrievalArtifact(source,artifact);
    for (const [chunkIndex,chunk] of artifact.chunks.entries()) {
      options.check?.(); scanned++; characters+=chunk.text.length; if(scanned>L.chunks||characters>L.sourceCharacters)limit();
      const {lower,offsets}=lowerWithOffsets(chunk.text),matchedTerms:string[]=[]; let firstMatch=chunk.text.length;
      for(const term of terms){const hit=lower.indexOf(term);if(hit>=0){matchedTerms.push(term);firstMatch=Math.min(firstMatch,offsets[hit]);}}
      if(matchedTerms.length)ranked.push({sourceIndex,chunkIndex,score:matchedTerms.length,matchedTerms,firstMatch});
      if(scanned%64===0){await options.yield?.();options.check?.();}
    }
  }
  ranked.sort((a,b)=>b.score-a.score||a.sourceIndex-b.sourceIndex||a.chunkIndex-b.chunkIndex);
  const evidence:RemoteRetrievalEvidence[]=[];
  for(const match of ranked.slice(0,request.topK)){
    options.check?.();const chunk=artifacts[match.sourceIndex].chunks[match.chunkIndex],part=excerpt(chunk.text,match.firstMatch);
    evidence.push({id:evidenceId(match.sourceIndex,match.chunkIndex),sourceIndex:match.sourceIndex,chunkIndex:match.chunkIndex,chunkId:chunk.id,pageIndex:chunk.pageIndex,
      text:part.text,excerptStart:part.start,fullTextLength:chunk.text.length,chunkDigest:await remoteRetrievalDigest({id:chunk.id,pageIndex:chunk.pageIndex,text:chunk.text}),
      excerptDigest:await bytesDigest(encoder.encode(part.text)),score:match.score,matchedTerms:match.matchedTerms});
  }
  const excerptCharacters=evidence.reduce((n,e)=>n+e.text.length,0);
  const result:RemoteRetrievalResult={version:1,mode:'lexical-v1',requestDigest:await remoteRetrievalDigest(request),terms,evidence,
    stats:{scannedChunks:scanned,sourceCharacters:characters,matchingChunks:ranked.length,omittedMatches:ranked.length-evidence.length,excerptCharacters,omittedCharacters:characters-excerptCharacters}};
  options.check?.();return validateRemoteRetrievalResult(result,request);
}
export function validateRemoteRetrievalResult(value: unknown, input: RemoteRetrievalRequest): RemoteRetrievalResult {
  const request=validateRemoteRetrievalRequest(input);inspect(value,L.resultBytes);
  const r=object(value,['version','mode','requestDigest','terms','evidence','stats']);if(r.version!==1||r.mode!=='lexical-v1')invalid();hash(r.requestDigest);
  const terms=array(r.terms,L.terms).map(t=>text(t,L.queryCharacters));if(canonicalJson(terms)!==canonicalJson(remoteRetrievalTerms(request.query)))invalid();
  const seen=new Set<string>(),evidence=array(r.evidence,request.topK).map(raw=>{
    const e=object(raw,['id','sourceIndex','chunkIndex','chunkId','pageIndex','text','excerptStart','fullTextLength','chunkDigest','excerptDigest','score','matchedTerms']);
    const sourceIndex=int(e.sourceIndex,0,request.sources.length-1),source=request.sources[sourceIndex],chunkIndex=int(e.chunkIndex,0,source.chunkCount-1);
    if(e.id!==evidenceId(sourceIndex,chunkIndex)||seen.has(String(e.id)))invalid();seen.add(String(e.id));
    const chunkId=text(e.chunkId,128);if(!ID.test(chunkId))invalid();
    const body=text(e.text,L.excerptCharacters),start=int(e.excerptStart,0,8192),length=int(e.fullTextLength,1,8192);if(start+body.length>length)invalid();
    const matchedTerms=array(e.matchedTerms,L.terms).map(t=>text(t,L.queryCharacters));
    if(!matchedTerms.length||new Set(matchedTerms).size!==matchedTerms.length||matchedTerms.some(t=>!terms.includes(t)))invalid();
    const score=int(e.score,1,terms.length);if(score!==matchedTerms.length)invalid();
    return {id:String(e.id),sourceIndex,chunkIndex,chunkId,pageIndex:int(e.pageIndex,0,source.target.pageCount!-1),text:body,excerptStart:start,fullTextLength:length,
      chunkDigest:hash(e.chunkDigest),excerptDigest:hash(e.excerptDigest),score,matchedTerms};
  });
  const stats=object(r.stats,['scannedChunks','sourceCharacters','matchingChunks','omittedMatches','excerptCharacters','omittedCharacters']);
  const expectedChunks=request.sources.reduce((n,s)=>n+s.chunkCount,0),expectedCharacters=request.sources.reduce((n,s)=>n+s.textCharacters,0),excerptCharacters=evidence.reduce((n,e)=>n+e.text.length,0);
  if(stats.scannedChunks!==expectedChunks||stats.sourceCharacters!==expectedCharacters||stats.excerptCharacters!==excerptCharacters||stats.omittedCharacters!==expectedCharacters-excerptCharacters)invalid();
  const matching=int(stats.matchingChunks,evidence.length,expectedChunks);if(stats.omittedMatches!==matching-evidence.length||evidence.length!==Math.min(request.topK,matching))invalid();
  for(let i=1;i<evidence.length;i++){const a=evidence[i-1],b=evidence[i];if(a.score<b.score||a.score===b.score&&(a.sourceIndex>b.sourceIndex||a.sourceIndex===b.sourceIndex&&a.chunkIndex>b.chunkIndex))invalid();}
  return {version:1,mode:'lexical-v1',requestDigest:String(r.requestDigest),terms,evidence,stats:{scannedChunks:expectedChunks,sourceCharacters:expectedCharacters,matchingChunks:matching,omittedMatches:matching-evidence.length,excerptCharacters,omittedCharacters:expectedCharacters-excerptCharacters}};
}
export async function validateRemoteRetrievalReceipt(value: unknown): Promise<RemoteRetrievalReceipt> {
  inspect(value,L.resultBytes+L.requestBytes+8192);const r=object(value,['version','request','requestDigest','result','resultDigest','createdAt']);if(r.version!==1)invalid();
  const request=validateRemoteRetrievalRequest(r.request),requestDigest=hash(r.requestDigest),result=validateRemoteRetrievalResult(r.result,request),resultDigest=hash(r.resultDigest);
  if(await remoteRetrievalDigest(request)!==requestDigest||result.requestDigest!==requestDigest||await remoteRetrievalDigest(result)!==resultDigest)invalid();
  for(const e of result.evidence)if(await bytesDigest(encoder.encode(e.text))!==e.excerptDigest)invalid();
  return {version:1,request,requestDigest,result,resultDigest,createdAt:stamp(r.createdAt)};
}
export async function validateRemoteRetrievalStatus(value: unknown): Promise<RemoteRetrievalStatus> {
  inspect(value,L.resultBytes+L.requestBytes+16384);const s=object(value,['requestId','status','requestDigest','receipt']),requestId=remoteRetrievalId(s.requestId);
  if(s.status==='absent'){if(s.requestDigest!==null||s.receipt!==null)invalid();return{requestId,status:'absent',requestDigest:null,receipt:null};}
  const requestDigest=hash(s.requestDigest);if(s.status==='removed'){if(s.receipt!==null)invalid();return{requestId,status:'removed',requestDigest,receipt:null};}
  if(s.status!=='complete')invalid();const receipt=await validateRemoteRetrievalReceipt(s.receipt);
  if(receipt.request.requestId!==requestId||receipt.requestDigest!==requestDigest)invalid();return{requestId,status:'complete',requestDigest,receipt};
}
