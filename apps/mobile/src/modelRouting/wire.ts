import {parseModelInferenceJson,MODEL_INFERENCE_LIMITS as L} from '../../../../packages/sync-core/src/modelInference.ts';
import {ClientError} from '../errors.ts';
import {ModelServiceError} from './errors.ts';
export async function waitForModelCall<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw new ClientError('ACCOUNT_CHANGED');let rejectStop!:(error:Error)=>void;const stopped=new Promise<never>((_resolve,reject)=>{rejectStop=reject;});const abort=()=>rejectStop(new ClientError('ACCOUNT_CHANGED'));signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();try{return await Promise.race([work,stopped]);}finally{signal.removeEventListener('abort',abort);}
}
export const MODEL_RESPONSE_BYTES=2*L.requestBytes+16384;
export async function readModelResponse(response:Response,signal:AbortSignal):Promise<unknown>{
 const invalid=()=>new ModelServiceError('MODEL_RESPONSE_INVALID',502);
 if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body){void response.body?.cancel().catch(()=>{});throw invalid();}
 const size=response.headers.get('content-length');if(size&&(!/^\d+$/.test(size)||Number(size)>MODEL_RESPONSE_BYTES)){void response.body.cancel().catch(()=>{});throw invalid();}
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,count=0,aborted=false,finished=false,rejectStop!:(error:Error)=>void;
 const stopped=new Promise<never>((_resolve,reject)=>{rejectStop=reject;});void stopped.catch(()=>{});
 const abort=()=>{aborted=true;rejectStop(new ClientError('ACCOUNT_CHANGED'));void reader.cancel().catch(()=>{});};
 signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{
  for(;;){const part=await Promise.race([reader.read(),stopped]);if(aborted||signal.aborted)throw new ClientError('ACCOUNT_CHANGED');if(part.done){finished=true;break;}if(!(part.value instanceof Uint8Array)||++count>4096||(bytes+=part.value.byteLength)>MODEL_RESPONSE_BYTES)throw invalid();chunks.push(Uint8Array.from(part.value));}
  const joined=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){joined.set(chunk,offset);offset+=chunk.byteLength;}
  try{return parseModelInferenceJson(joined,MODEL_RESPONSE_BYTES);}catch{throw invalid();}
 }finally{signal.removeEventListener('abort',abort);if(!finished)void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}
}
