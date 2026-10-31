/** One explicit upstream chat request. Private transport settings never come from a peer's invocation payload. */
export class ModelUpstreamError extends Error {
 constructor(code,sent=false){super(code);this.name='ModelUpstreamError';this.code=code;this.sent=sent;}
}
const CODES=new Set(['PROFILE_CHANGED','UPSTREAM_REJECTED','UPSTREAM_UNAVAILABLE','OUTCOME_UNKNOWN','OUTPUT_INVALID','OUTPUT_LIMIT','CANCELLED']);
const encoder=new TextEncoder();
function fail(code,sent=false){throw new ModelUpstreamError(code,sent);}
function exact(value,fields){if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))fail('PROFILE_CHANGED');const d=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(value).length!==fields.length||fields.some(f=>!Object.hasOwn(d,f))||Object.values(d).some(v=>!v.enumerable||!('value'in v)))fail('PROFILE_CHANGED');}
export function normalizePrivateModelConfiguration(input){
 exact(input,['endpoint','model','apiKey','requiresKey','tokenParameter','maxOutputTokens']);
 const {endpoint,model,apiKey,requiresKey,tokenParameter,maxOutputTokens}=input;
 if(typeof endpoint!=='string'||endpoint.length>2048||/[\x00-\x20\x7f\\?#]/.test(endpoint)||/%(?:00|0a|0d)/i.test(endpoint)||typeof model!=='string'||!/^[-A-Za-z0-9_./:@+]{1,160}$/.test(model)||typeof apiKey!=='string'||apiKey.length>4096||apiKey&&!/^[\x21-\x7e]+$/.test(apiKey)||typeof requiresKey!=='boolean'||requiresKey&&!apiKey||!['max_tokens','max_completion_tokens'].includes(tokenParameter)||!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<64||maxOutputTokens>8192)fail('PROFILE_CHANGED');
 let url;try{url=new URL(endpoint);}catch{fail('PROFILE_CHANGED');}
 if(!['https:','http:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash||/\/(?:chat\/completions|models)\/?$/.test(url.pathname))fail('PROFILE_CHANGED');url.pathname=url.pathname.replace(/\/+$/,'');
 return{endpoint:url.href.replace(/\/$/,''),model,apiKey,requiresKey,tokenParameter,maxOutputTokens};
}
function cancelBody(response){try{void response?.body?.cancel().catch(()=>{});}catch{}}
function usage(value){if(value===undefined||value===null)return null;if(!value||typeof value!=='object'||Array.isArray(value))fail('OUTPUT_INVALID',true);const values=['prompt_tokens','completion_tokens','total_tokens'].map(k=>value[k]);if(values.some(v=>!Number.isSafeInteger(v)||v<0||v>1e9)||values[2]!==values[0]+values[1])fail('OUTPUT_INVALID',true);return{promptTokens:values[0],completionTokens:values[1],totalTokens:values[2]};}
export function createModelInferenceAdapter(options){
 if(!options||typeof options.validateRequest!=='function'||typeof options.prepareOutput!=='function'||typeof options.parseJson!=='function')fail('PROFILE_CHANGED');
 const fetcher=options.fetch??globalThis.fetch.bind(globalThis),mono=options.monotonic??(()=>performance.now()),timeoutMs=Math.min(options.timeoutMs??110000,110000);
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1)fail('PROFILE_CHANGED');
 return{async execute(input){
  const controller=new AbortController(),deadline=mono()+timeoutMs;let sent=false,response,reader,closed=false,reason=null;
  const stopped=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(reason??new ModelUpstreamError(sent?'OUTCOME_UNKNOWN':'CANCELLED',sent)),{once:true});});
  const stop=(error)=>{if(!controller.signal.aborted){reason=error;controller.abort();}},abort=()=>stop(new ModelUpstreamError('CANCELLED',sent)),timer=setTimeout(()=>stop(new ModelUpstreamError(sent?'OUTCOME_UNKNOWN':'CANCELLED',sent)),timeoutMs);
  // Attach rejection handling even if cancellation happens during synchronous preflight.
  void stopped.catch(()=>{});if(input.signal?.aborted)abort();else input.signal?.addEventListener('abort',abort,{once:true});
  const check=()=>{if(mono()>=deadline)stop(new ModelUpstreamError(sent?'OUTCOME_UNKNOWN':'CANCELLED',sent));if(controller.signal.aborted)throw reason;let current=true;try{current=input.current?input.current():true;}catch{current=false;}if(!current)fail(sent?'OUTCOME_UNKNOWN':'PROFILE_CHANGED',sent);};
  const wait=async(promise)=>{const result=await Promise.race([Promise.resolve(promise),stopped]);check();return result;};
  try{
   check();const config=normalizePrivateModelConfiguration(input.config),request=await wait(options.validateRequest(input.request));
   if(request.model!==config.model||request.maxOutputTokens>config.maxOutputTokens)fail('PROFILE_CHANGED');const body=JSON.stringify({model:config.model,messages:request.messages,n:1,stream:false,[config.tokenParameter]:request.maxOutputTokens});if(encoder.encode(body).length>256*1024)fail('OUTPUT_LIMIT');
   if(typeof input.authorize!=='function'||await wait(input.authorize())!==true)fail('PROFILE_CHANGED');check();
   const url=config.endpoint+'/chat/completions';sent=true;const pending=Promise.resolve(fetcher(url,{method:'POST',headers:{Accept:'application/json','Content-Type':'application/json',...(config.requiresKey?{Authorization:'Bearer '+config.apiKey}:{})},body,signal:controller.signal,credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store'}));void pending.then(r=>{response=r;if(closed||controller.signal.aborted)cancelBody(r);},()=>{});response=await wait(pending);
   if(response.redirected||['opaque','opaqueredirect','error'].includes(response.type)||response.url&&response.url!==url)fail('OUTPUT_INVALID',true);
   if(response.status!==200)fail(response.status>=500?'UPSTREAM_UNAVAILABLE':'UPSTREAM_REJECTED',true);
   if(response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()!=='application/json'||!response.body)fail('OUTPUT_INVALID',true);const size=response.headers.get('content-length');if(size&&/^\d+$/.test(size)&&Number(size)>1024*1024)fail('OUTPUT_LIMIT',true);reader=response.body.getReader();let bytes=0,chunks=[];
   for(let count=0;;count++){const part=await wait(reader.read());if(part.done)break;if(!(part.value instanceof Uint8Array))fail('OUTPUT_INVALID',true);bytes+=part.value.length;if(count>=4096||bytes>1024*1024)fail('OUTPUT_LIMIT',true);chunks.push(part.value);}
   const raw=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){raw.set(chunk,offset);offset+=chunk.length;}let json;try{json=options.parseJson(raw,1024*1024);}catch{fail('OUTPUT_INVALID',true);}
   if(!json||typeof json!=='object'||Array.isArray(json)||!Array.isArray(json.choices)||json.choices.length!==1)fail('OUTPUT_INVALID',true);const choice=json.choices[0],message=choice?.message;
   if(choice?.index!==0||!message||typeof message!=='object'||Array.isArray(message)||message.role!==undefined&&message.role!=='assistant'||typeof message.content!=='string'||message.tool_calls!==undefined&&(!Array.isArray(message.tool_calls)||message.tool_calls.length)||message.function_call!==undefined&&message.function_call!==null||!['stop','length','content_filter'].includes(choice.finish_reason))fail('OUTPUT_INVALID',true);
   let text=message.content,reportedModel=json.model===undefined?null:json.model,redacted=false;if(reportedModel!==null&&(typeof reportedModel!=='string'||!/^[-A-Za-z0-9_./:@+]{1,160}$/.test(reportedModel)))fail('OUTPUT_INVALID',true);
   // A disabled-key local model never sends the configured key; retaining it also never permits reflecting it to a client.
   if(config.apiKey){if(text.includes(config.apiKey)){text=text.split(config.apiKey).join('[credential hidden]');redacted=true;}if(reportedModel?.includes(config.apiKey)){reportedModel=null;redacted=true;}}
   check();let result;try{result=await wait(options.prepareOutput({text,usage:usage(json.usage),reportedModel,finishReason:choice.finish_reason,redacted}));}catch(error){if(error instanceof ModelUpstreamError)throw error;fail(encoder.encode(text).length>240*1024?'OUTPUT_LIMIT':'OUTPUT_INVALID',true);}check();return result;
  }catch(error){if(error instanceof ModelUpstreamError&&CODES.has(error.code))throw error;if(reason)throw reason;throw new ModelUpstreamError(sent?'OUTCOME_UNKNOWN':'PROFILE_CHANGED',sent);}
  finally{closed=true;clearTimeout(timer);input.signal?.removeEventListener('abort',abort);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}cancelBody(response);stop(new ModelUpstreamError('CANCELLED',sent));}
 }};
}
