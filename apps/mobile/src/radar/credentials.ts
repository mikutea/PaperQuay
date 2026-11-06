import type{SecretStore}from'../platform/secretStore.ts';import{radarSecretNamespace,validateRadarKey,type RadarScope}from'./client.ts';import{RadarError}from'./config.ts';import{changedRadarState,type RadarState}from'./model.ts';
export async function replaceRadarCredential(input:{state:RadarState;value:string|null;store?:SecretStore;scope:RadarScope;current():boolean;save(next:RadarState,expected:number):Promise<RadarState>;refresh():Promise<RadarState|null>;makeId?:()=>string}):Promise<void>{
 const {state,store}=input;if(!input.current())throw new RadarError('CHANGED');if(state.run?.finishedAt===null)throw new RadarError('PENDING');if(input.value!==null&&!store)throw new RadarError('UNSUPPORTED');const namespace=radarSecretNamespace(input.scope),ref=input.value===null?null:(input.makeId??(()=>crypto.randomUUID()))();
 if(ref){await store!.set(namespace,ref,validateRadarKey(input.value));if(!input.current()){await store!.remove(namespace,ref).catch(()=>{});throw new RadarError('CHANGED');}}
 const next=changedRadarState(state,d=>{d.credentialRef=ref;});let confirmed=false;
 try{await input.save(next,state.revision);confirmed=input.current();}catch(error){
  // Storage may have committed before its acknowledgement failed. Never erase a possibly referenced secret.
  if(input.current()){try{const saved=await input.refresh();confirmed=input.current()&&saved?.credentialRef===ref&&saved.revision>=next.revision;}catch{}}
  if(!confirmed)throw error;
 }
 if(!confirmed)throw new RadarError('CHANGED');if(state.credentialRef&&store)await store.remove(namespace,state.credentialRef).catch(()=>{});
}
