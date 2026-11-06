export const AGENT_LIMITS = Object.freeze({ targets:64, targetBytes:1024*1024, proposalBytes:4*1024*1024, receipts:256, classificationWork:32000000 });
export class AgentError extends Error {
  constructor(readonly code:'INVALID'|'LIMIT'|'CHANGED'|'BLOCKED'|'UNSUPPORTED'|'EMPTY'|'PENDING'|'DELETED'|'COMPLEXITY') { super(code); this.name='AgentError'; }
}
export const agentUuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const agentHash=/^[0-9a-f]{64}$/;
export function agentObject(v:unknown):v is Record<string,unknown> { return Boolean(v&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v))); }
export function agentOnly(v:Record<string,unknown>,keys:readonly string[]):void { if(Reflect.ownKeys(v).some(k=>typeof k!=='string'||!keys.includes(k)))throw new AgentError('INVALID'); }
export function agentText(v:unknown,max:number,required=false):string {
  if(typeof v!=='string'||v.length>max||required&&!v.trim())throw new AgentError('INVALID');
  for(const c of v){const n=c.charCodeAt(0);if(n<32&&![9,10,13].includes(n)||n===127)throw new AgentError('INVALID');}
  try{encodeURIComponent(v);}catch{throw new AgentError('INVALID');}return v;
}
/** Inspect descriptors before serialization, including imported/proposed objects. */
export function inspectAgentJson(value:unknown,maxBytes=AGENT_LIMITS.proposalBytes):void {
  let nodes=0,chars=0;const seen=new Set<object>();
  function visit(v:unknown,depth:number){
    if(++nodes>500000||depth>24)throw new AgentError('LIMIT');
    if(typeof v==='string'){chars+=v.length;if(chars>maxBytes)throw new AgentError('LIMIT');return;}
    if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v))return;
    if(!v||typeof v!=='object'||seen.has(v)||!Array.isArray(v)&&!agentObject(v))throw new AgentError('INVALID');
    seen.add(v);const keys=Reflect.ownKeys(v);
    for(const k of keys){if(Array.isArray(v)&&k==='length')continue;if(typeof k!=='string')throw new AgentError('INVALID');const d=Object.getOwnPropertyDescriptor(v,k)!;if(!d.enumerable||!('value'in d))throw new AgentError('INVALID');if(Array.isArray(v)&&(!/^(0|[1-9][0-9]*)$/.test(k)||Number(k)>=v.length))throw new AgentError('INVALID');chars+=k.length;if(chars>maxBytes)throw new AgentError('LIMIT');visit(d.value,depth+1);}
    if(Array.isArray(v)&&keys.length!==v.length+1)throw new AgentError('INVALID');seen.delete(v);
  }
  visit(value,0);if(new TextEncoder().encode(JSON.stringify(value)).length>maxBytes)throw new AgentError('LIMIT');
}
