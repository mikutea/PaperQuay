import test from'node:test';import assert from'node:assert/strict';
import{createDesktopGraphMapping,desktopGraphRelationToWire,graphWireToDesktop,desktopAccountGraphId,parseDesktopAccountGraphId,DESKTOP_GRAPH_LIMITS,type DesktopGraphScope,type DesktopGraphMaterialBinding}from'../packages/sync-core/src/desktopGraph.ts';
import{validateEntityData,type SyncRecord}from'../packages/sync-core/src/index.ts';
const id=(n:number)=>'00000000-0000-4000-8000-'+n.toString(16).padStart(12,'0'),scope:DesktopGraphScope={serviceKey:'a'.repeat(64),accountId:id(1),libraryBindingId:id(2)};
const input=()=>({scope:{...scope},bindings:[{entityType:'paper' as const,localId:'local-paper',entityId:id(10)},{entityType:'note' as const,localId:'local-note',entityId:id(11)}],live:{paperIds:['local-paper'],noteIds:['local-note']}});
const raw=()=>({id:'local-relation',source:'paper:local-paper',target:'note:local-note',type:'ai_suggested',label:'Explicit saved relation',description:'Original description\nSecond line',confidence:null,weight:.66,createdAt:0,updatedAt:null});
const mapping=()=>createDesktopGraphMapping(input());
const record=():SyncRecord<'graphRelation'>=>({entityType:'graphRelation',entityId:id(70),schemaVersion:1,revision:3,deletedAt:null,updatedAt:'2026-10-31T00:00:00.000Z',modifiedByDeviceId:id(20),data:desktopGraphRelationToWire(raw(),mapping(),scope).data});
test('current unique mappings are scoped, detached, branded, immutable and independent of input order',()=>{
 const value=input(),m=createDesktopGraphMapping(value),reordered=createDesktopGraphMapping({...input(),bindings:[...value.bindings].reverse().concat(value.bindings)});
 assert.equal(m.identity,reordered.identity);assert.equal(m.bindings.length,2);assert.equal(m.blocked.length,0);value.bindings[0].entityId=id(90);value.scope.accountId=id(90);assert.equal(m.bindings.find(b=>b.entityType==='paper')!.entityId,id(10));assert.equal(m.scope.accountId,id(1));
 assert(Object.isFrozen(m)&&Object.isFrozen(m.scope)&&Object.isFrozen(m.bindings)&&m.bindings.every(Object.isFrozen));assert.throws(()=>{(m.bindings[0] as any).entityId=id(90);});
 assert.throws(()=>desktopGraphRelationToWire(raw(),JSON.parse(JSON.stringify(m)),scope),{code:'INVALID_GRAPH_MAPPING'});
});
test('ambiguous forward/reverse bindings never select one alias, and absent historical materials cannot block a current unique binding',()=>{
 const a=input(),forward=createDesktopGraphMapping({...a,bindings:[...a.bindings,{entityType:'paper',localId:'local-paper',entityId:id(12)}]});assert.equal(forward.bindings.some(b=>b.entityType==='paper'),false);assert.equal(forward.blocked[0].code,'AMBIGUOUS_LOCAL_MAPPING');
 const reverse=createDesktopGraphMapping({...a,bindings:[...a.bindings,{entityType:'paper',localId:'other-paper',entityId:id(10)}],live:{...a.live,paperIds:['local-paper','other-paper']}});assert.equal(reverse.bindings.some(b=>b.entityType==='paper'),false);assert(reverse.blocked.every(b=>b.code==='AMBIGUOUS_ACCOUNT_MAPPING'));
 const inactive=createDesktopGraphMapping({...a,bindings:[...a.bindings,{entityType:'paper',localId:'deleted-paper',entityId:id(10)}]});assert.equal(inactive.bindings.length,2);assert.equal(inactive.blocked[0].code,'MISSING_LOCAL_MATERIAL');
});
test('desktop projection emits only typed account endpoints and preserves source, exact text, zero timestamps and unknown score',()=>{
 const source=raw(),before=structuredClone(source),out=desktopGraphRelationToWire(source,mapping(),scope);assert.deepEqual(source,before);assert.equal(out.localRelationId,'local-relation');assert.deepEqual(out.data.source,{entityType:'paper',entityId:id(10)});assert.deepEqual(out.data.target,{entityType:'note',entityId:id(11)});assert.equal(out.data.createdAt,'1970-01-01T00:00:00.000Z');assert.equal(out.data.updatedAt,null);assert.equal(out.data.confidence,null);assert.equal(out.data.description,source.description);assert.equal(validateEntityData('graphRelation',out.data).ok,true);assert(!JSON.stringify(out.data).includes('local-'));
 for(const confidence of[0,.82,1])assert.equal(desktopGraphRelationToWire({...raw(),confidence},mapping(),scope).data.confidence,confidence);
 const updated=desktopGraphRelationToWire({...raw(),updatedAt:1000},mapping(),scope);assert.equal(updated.data.updatedAt,'1970-01-01T00:00:01.000Z');
});
test('source strings, paths, virtual nodes and matching UUID text cannot fabricate endpoint ownership',()=>{
 const m=mapping();for(const source of['paper:'+id(10),'tag:local-paper','paper:missing','paper:C:\\private\\paper','file:///private/graph'])assert.throws(()=>desktopGraphRelationToWire({...raw(),source},m,scope),{code:'UNMAPPED_GRAPH_ENDPOINT'});
 for(const next of[{...scope,serviceKey:'b'.repeat(64)},{...scope,accountId:id(3)},{...scope,libraryBindingId:id(3)}]){assert.throws(()=>desktopGraphRelationToWire(raw(),m,next),{code:'GRAPH_MAPPING_CHANGED'});assert.throws(()=>graphWireToDesktop(record(),m,next),{code:'GRAPH_MAPPING_CHANGED'});}
});
test('closed desktop relation input rejects authority, malformed numbers and getters without invoking them or clipping descriptions',()=>{
 let reads=0;const getter=Object.defineProperty({...raw()},'source',{enumerable:true,get(){reads++;return'paper:local-paper';}});
 for(const row of[getter,{...raw(),apiKey:'SENTINEL_PRIVATE'},{...raw(),confidence:'0.7'},{...raw(),confidence:true},{...raw(),weight:NaN},{...raw(),createdAt:'0'},{...raw(),updatedAt:-1},{...raw(),description:'x'.repeat(4097)},{...raw(),[Symbol('secret')]:'never'}])assert.throws(()=>desktopGraphRelationToWire(row,mapping(),scope),{code:'INVALID_DESKTOP_GRAPH_RELATION'});
 assert.equal(reads,0);try{desktopGraphRelationToWire({...raw(),password:'SENTINEL_PRIVATE'},mapping(),scope);}catch(e){assert(!String(e).includes('SENTINEL_PRIVATE'));}
});
test('account graph projections keep origin and unknown values without creating local material or changing the wire record',()=>{
 const r=record(),before=structuredClone(r),out=graphWireToDesktop(r,mapping(),scope);assert.deepEqual(r,before);assert.equal(out.kind,'mapped');if(out.kind!=='mapped')throw Error();assert.equal(out.relation.id,desktopAccountGraphId(r.entityId));assert.equal(out.relation.scope,'account');assert.equal(out.relation.source,'paper:local-paper');assert.equal(out.relation.target,'note:local-note');assert.equal(out.relation.createdAt,0);assert.equal(out.relation.updatedAt,undefined);assert.equal(out.relation.confidence,undefined);assert.equal(out.relation.type,'ai_suggested');assert.equal(parseDesktopAccountGraphId(out.relation.id),r.entityId);assert.equal(parseDesktopAccountGraphId('local-relation'),null);assert.equal(parseDesktopAccountGraphId('account-graph:C:\\private'),null);
});
test('incoming missing endpoints stay explicit and tombstones need no present material or guessed local identity',()=>{
 const m=createDesktopGraphMapping({...input(),bindings:[],live:{paperIds:[],noteIds:[]}}),incoming=graphWireToDesktop(record(),m,scope);assert.equal(incoming.kind,'unmapped');if(incoming.kind!=='unmapped')throw Error();assert.deepEqual(incoming.missing,[{entityType:'paper',entityId:id(10)},{entityType:'note',entityId:id(11)}]);
 const deleted=graphWireToDesktop({...record(),deletedAt:'2026-10-31T00:00:00.000Z',data:null},m,scope);assert.deepEqual(deleted,{kind:'deleted',entityId:id(70),revision:3});
});
test('the same UUID in distinct endpoint types stays distinct and never becomes an identity collision',()=>{
 const value=input();value.bindings[1].entityId=id(10);const m=createDesktopGraphMapping(value),data=desktopGraphRelationToWire(raw(),m,scope).data;assert.equal(data.source.entityId,data.target.entityId);assert.notEqual(data.source.entityType,data.target.entityType);const out=graphWireToDesktop({...record(),data},m,scope);assert.equal(out.kind,'mapped');if(out.kind!=='mapped')throw Error();assert.notEqual(out.relation.source,out.relation.target);
});
test('mapping capacities and closed descriptor checks reject expansion before conversion',()=>{
 assert.throws(()=>createDesktopGraphMapping({...input(),bindings:Array.from({length:DESKTOP_GRAPH_LIMITS.mappings+1},()=>input().bindings[0])}),{code:'GRAPH_LIMIT'});
 for(const patch of[{scope:{...scope,endpoint:'https://private.test'}},{bindings:[{...input().bindings[0],owner:'untrusted'}]},{live:{...input().live,secret:'never'}}])assert.throws(()=>createDesktopGraphMapping({...input(),...patch} as any),{code:'INVALID_GRAPH_MAPPING'});
 let reads=0;const binding=Object.defineProperty({...input().bindings[0]},'entityId',{enumerable:true,get(){reads++;return id(10);}});assert.throws(()=>createDesktopGraphMapping({...input(),bindings:[binding]}));assert.equal(reads,0);
});
