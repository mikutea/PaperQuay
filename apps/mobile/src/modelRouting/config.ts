import {parseAiProvider,aiAccountKey,canonicalAiEndpoint,validateAiModelExecution} from '../ai/provider.ts';
import {AiError} from '../ai/errors.ts';
import type {AiAccountScope,AiProviderConfig,AiModelExecution} from '../ai/types.ts';
import {validateModelInferenceTarget,validateModelInferenceProfile,modelInferenceDigest} from '../../../../packages/sync-core/src/modelInference.ts';
import type {ModelInferenceTarget,ModelInferenceProfile} from '../../../../packages/sync-core/src/modelInference.ts';
export async function createModelRouteProvider(scope:AiAccountScope,targetValue:ModelInferenceTarget,profileValue:ModelInferenceProfile,outputTokens?:number):Promise<AiProviderConfig>{
 const account=aiAccountKey(scope),base=canonicalAiEndpoint(scope.apiBaseUrl),target=validateModelInferenceTarget(targetValue),profile=validateModelInferenceProfile(profileValue),execution:AiModelExecution=validateAiModelExecution({version:1,target,profileRef:{id:profile.id,revision:profile.revision,digest:profile.digest}});
 const maxOutputTokens=outputTokens??Math.min(2048,profile.maxOutputTokens);if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<64||maxOutputTokens>profile.maxOutputTokens)throw new AiError('CONFIG_INVALID');
 const digest=await modelInferenceDigest([account,execution,profile.model]);
 return parseAiProvider({version:1,id:'remote_'+digest.slice(0,40),endpoint:base+'/v1/model-inference',model:profile.model,stream:false,includeUsage:false,requiresKey:false,maxOutputTokens,tokenParameter:'max_tokens',execution},true);
}
export function assertModelRouteScope(scope:AiAccountScope,value:AiProviderConfig):AiProviderConfig{
 aiAccountKey(scope);const config=parseAiProvider(value,true);if(!config.execution||config.endpoint!==canonicalAiEndpoint(scope.apiBaseUrl)+'/v1/model-inference')throw new AiError('CONFIG_INVALID');return config;
}

/** Verify the deterministic private identity as well as the service URL before any account HTTP. */
export async function validateModelRouteConfig(scope:AiAccountScope,value:AiProviderConfig):Promise<AiProviderConfig>{const config=assertModelRouteScope(scope,value),digest=await modelInferenceDigest([aiAccountKey(scope),config.execution!,config.model]);if(config.id!=='remote_'+digest.slice(0,40))throw new AiError('CONFIG_INVALID');return config;}
