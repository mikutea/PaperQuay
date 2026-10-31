import type {ModelInferenceRequest,ModelInferenceOutput} from '../sync-core/src/modelInference.ts';
export type ModelUpstreamCode='PROFILE_CHANGED'|'UPSTREAM_REJECTED'|'UPSTREAM_UNAVAILABLE'|'OUTCOME_UNKNOWN'|'OUTPUT_INVALID'|'OUTPUT_LIMIT'|'CANCELLED';
export class ModelUpstreamError extends Error{readonly code:ModelUpstreamCode;readonly sent:boolean;constructor(code:ModelUpstreamCode,sent?:boolean)}
export interface PrivateModelConfiguration{endpoint:string;model:string;apiKey:string;requiresKey:boolean;tokenParameter:'max_tokens'|'max_completion_tokens';maxOutputTokens:number}
export function normalizePrivateModelConfiguration(input:unknown):PrivateModelConfiguration;
export interface ModelInferenceAdapter{execute(input:{request:ModelInferenceRequest;config:PrivateModelConfiguration;signal?:AbortSignal;current?():boolean;authorize():Promise<boolean>|boolean}):Promise<ModelInferenceOutput>}
export function createModelInferenceAdapter(options:{fetch?:typeof globalThis.fetch;monotonic?():number;timeoutMs?:number;validateRequest(input:unknown):Promise<ModelInferenceRequest>;prepareOutput(input:Omit<ModelInferenceOutput,'version'|'digest'>):Promise<ModelInferenceOutput>;parseJson(bytes:Uint8Array,max?:number):unknown}):ModelInferenceAdapter;
