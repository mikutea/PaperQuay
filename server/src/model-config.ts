import {createHash,createHmac} from 'node:crypto';
import {normalizePrivateModelConfiguration,type PrivateModelConfiguration} from '../../packages/model-inference/index.mjs';
import {canonicalJson} from '../../packages/sync-core/src/validation.ts';
import {MODEL_INFERENCE_LIMITS,type ModelInferenceProfile} from '../../packages/sync-core/src/modelInference.ts';
import {ApiError} from './errors.ts';
export interface ModelGatewayConfig{provider:PrivateModelConfiguration;allowedSubjects:string[]}
function flag(value:string|undefined,defaultValue='0'):boolean{const v=value??defaultValue;if(!['0','1'].includes(v))throw new ApiError('CONFIGURATION_INVALID',500);return v==='1';}
/** Deployment-only configuration. No client request supplies an upstream address, credential or authorized subject. */
export function loadModelGatewayConfig(env:NodeJS.ProcessEnv,inferenceEnabled:boolean):ModelGatewayConfig|null{
 const enabled=flag(env.PAPERQUAY_MODEL_GATEWAY_ENABLED);if(!enabled)return null;if(!inferenceEnabled)throw new ApiError('CONFIGURATION_INVALID',500);
 let subjects:unknown;try{subjects=JSON.parse(env.PAPERQUAY_MODEL_GATEWAY_ALLOWED_SUBJECTS??'');}catch{throw new ApiError('CONFIGURATION_INVALID',500);}
 if(!Array.isArray(subjects)||!subjects.length||subjects.length>128||subjects.some(v=>typeof v!=='string'||!v.length||v.length>255||v==='*'||/[\x00-\x1f\x7f]/.test(v))||new Set(subjects).size!==subjects.length)throw new ApiError('CONFIGURATION_INVALID',500);
 let provider:PrivateModelConfiguration;try{provider=normalizePrivateModelConfiguration({endpoint:env.PAPERQUAY_MODEL_GATEWAY_ENDPOINT?.trim()??'',model:env.PAPERQUAY_MODEL_GATEWAY_MODEL?.trim()??'',apiKey:env.PAPERQUAY_MODEL_GATEWAY_API_KEY?.trim()??'',requiresKey:flag(env.PAPERQUAY_MODEL_GATEWAY_REQUIRE_KEY,'1'),tokenParameter:env.PAPERQUAY_MODEL_GATEWAY_TOKEN_PARAMETER??'max_tokens',maxOutputTokens:Number(env.PAPERQUAY_MODEL_GATEWAY_MAX_OUTPUT_TOKENS??2048)});}catch{throw new ApiError('CONFIGURATION_INVALID',500);}
 const url=new URL(provider.endpoint),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname),allowHttp=flag(env.PAPERQUAY_MODEL_GATEWAY_ALLOW_INSECURE_HTTP);
 if(url.protocol==='http:'&&!local&&!allowHttp)throw new ApiError('CONFIGURATION_INVALID',500);
 return{provider,allowedSubjects:[...subjects]as string[]};
}
/** The opaque public epoch changes with private credentials without publishing a guessable credential fingerprint. */
export function modelGatewayProfile(configuration:ModelGatewayConfig,serverSecret:Uint8Array):ModelInferenceProfile{
 if(!(serverSecret instanceof Uint8Array)||serverSecret.length<32||serverSecret.length>128)throw new ApiError('CONFIGURATION_INVALID',500);const config=normalizePrivateModelConfiguration(configuration.provider),privateEpoch=createHmac('sha256',serverSecret).update(canonicalJson(config)).digest('hex');
 const body={id:'gateway-default',revision:1,kind:'chat' as const,model:config.model,maxInputBytes:MODEL_INFERENCE_LIMITS.inputBytes,maxOutputTokens:config.maxOutputTokens,stream:false as const};return{...body,digest:createHash('sha256').update(canonicalJson({public:body,privateEpoch})).digest('hex')};
}
export function modelGatewayAuthorized(configuration:ModelGatewayConfig|null|undefined,subject:string):boolean{return Boolean(configuration?.allowedSubjects.includes(subject));}
