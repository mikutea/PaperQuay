import {canonicalJson,type VisibleEntity,type PaperData} from '../../../packages/sync-core/src/index.ts';
import {collectReviewSources} from '../src/review/sources.ts';
import {createReviewProject,manualReviewBlueprint,type ReviewSettings,type ReviewProject} from '../src/review/model.ts';
import {reviewCore} from '../src/review/core.ts';
export const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
export const scope={apiBaseUrl:'https://sync.example.test',accountId:id(1)},now='2026-10-30T13:00:00.000Z';
export const settings:ReviewSettings={intent:'研究证据的综合比较',reviewType:'comparative',targetAudience:'研究者',outputLanguage:'中文'};
export const paper:PaperData={title:'Synthetic evidence',authors:['Synthetic A'],doi:'10.1000/synthetic',year:'2026',publication:'Fixture',keywords:['evidence'],abstractText:'Captured methods and research limitations.'};
export const entities:VisibleEntity[]=[{entityType:'paper',entityId:id(2),data:paper,revision:1,deleted:false,pending:false,status:'synced'},
 {entityType:'note',entityId:id(3),data:{paperId:id(2),title:'Synthetic note',format:'markdown',body:'A **note** with evidence.'},revision:1,deleted:false,pending:false,status:'synced'}];
export async function project(withBlueprint=true):Promise<ReviewProject>{const bundle=await collectReviewSources({entities,selections:[{kind:'paper',id:id(2),versionId:null},{kind:'note',id:id(3),versionId:null}],scope,current:()=>true});const p=createReviewProject(id(10),settings,bundle.sources,now);if(withBlueprint){p.blueprint=manualReviewBlueprint(p.sources,p.settings);p.parts=reviewCore.emptyReviewGeneratedPartsForBlueprint(p.blueprint);}return p;}
export function memoryStore(initial:ReviewProject){let value=structuredClone(initial),calls=0;return{get:()=>structuredClone(value),set:(p:ReviewProject)=>{value=structuredClone(p);},calls:()=>calls,save:async(next:ReviewProject,expected:{id:string;revision:number},guard:()=>boolean)=>{if(!guard()||value.id!==expected.id||value.revision!==expected.revision)throw Error('CAS/owner');calls++;value=structuredClone(next);return structuredClone(value);}};}
export const completion=(text:string)=>({choices:[{index:0,message:{content:text},finish_reason:'stop'}]});
export function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return{promise,resolve};}
export async function tickUntil(check:()=>boolean){for(let i=0;i<200&&!check();i++)await new Promise(r=>setTimeout(r,2));if(!check())throw Error('Timed out');}
