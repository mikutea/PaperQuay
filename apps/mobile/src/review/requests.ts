import {reviewFingerprint} from './fingerprint.ts';
import {canonicalJson} from '../../../../packages/sync-core/src/index.ts';
import {reviewCore,type ReviewMessage} from './core.ts';
import {ReviewError,validateReviewProject,reviewSlots,type ReviewProject} from './model.ts';
export interface ReviewRequest {version:1;projectId:string;identity:string;kind:'blueprint'|'part';key:string|null;messages:ReviewMessage[];sourceIds:string[];figureIds:string[];digest:string}
const encoder=new TextEncoder();
export async function reviewDigest(value:unknown):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(canonicalJson(value))))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export function reviewProjectIdentity(p:ReviewProject):string{return reviewFingerprint([p.id,p.settings,p.sources,p.blueprint]);}
export async function prepareReviewRequest(input:ReviewProject,key:string|null):Promise<ReviewRequest>{
 const p=validateReviewProject(input),options={...p.settings,contextItems:p.sources.map(s=>s.context)};let messages:ReviewMessage[];
 if(key===null)messages=reviewCore.buildReviewBlueprintPrompt(options);
 else{const slot=reviewSlots(p).find(s=>s.key===key);if(!slot||!p.blueprint)throw new ReviewError('CHANGED');
  const heading=({abstract:'Abstract',introduction:'Introduction',conclusion:'Conclusion',research_gap:'Research Gap',future_direction:'Future Direction'} as Record<string,string>)[slot.kind]??slot.heading;
  messages=reviewCore.buildReviewPartPrompt({options,blueprint:p.blueprint,kind:slot.kind,heading,task:slot.task,contextItems:options.contextItems});}
 const payload=JSON.parse(messages[1].content),context=key===null?(payload.retrievedContext??payload.contextItems??[]):payload.selectedContext;
 // The actual shared prompt owns selection and truncation; parse it rather than assuming all captured sources are sent.
 const sourceIds=Array.isArray(context)?context.map((c:{id:string})=>c.id):[];
 if(!sourceIds.length)throw new ReviewError('INVALID');
 const figureIds=key===null?p.sources.flatMap(s=>(s.context.figures??[]).map(f=>f.id)):(payload.selectedFigures??[]).map((f:{id:string})=>f.id);
 const request={version:1 as const,projectId:p.id,identity:reviewProjectIdentity(p),kind:key===null?'blueprint' as const:'part' as const,key,messages,sourceIds,figureIds};
 return {...request,digest:await reviewDigest(request)};
}
export async function validateReviewRequest(value:ReviewRequest):Promise<ReviewRequest>{
 const request=structuredClone(value),{digest,...body}=request;
 if(request.version!==1||!['blueprint','part'].includes(request.kind)||request.kind==='blueprint'&&request.key!==null||request.kind==='part'&&typeof request.key!=='string'
  ||!Array.isArray(request.messages)||request.messages.length!==2||request.messages[0].role!=='system'||request.messages[1].role!=='user'
  ||request.messages.some(m=>typeof m.content!=='string')||!Array.isArray(request.sourceIds)||!request.sourceIds.length||request.sourceIds.length>8
  ||request.sourceIds.some(id=>!/^[PN][1-8]$/.test(id))||!Array.isArray(request.figureIds)||request.figureIds.length>48
  ||request.figureIds.some(id=>!/^P[1-8]-F[1-6]$/.test(id))||encoder.encode(JSON.stringify(request.messages)).length>192*1024
  ||await reviewDigest(body)!==digest)throw new ReviewError('INVALID');return request;
}
