import type{VisibleEntity,PaperData}from'../../../../packages/sync-core/src/index.ts';
import{radarCore}from'./core.ts';import{RadarError}from'./config.ts';import{radarLibrary,type RadarState}from'./model.ts';
export interface RadarQueueScope{tag:string;collection:string}
/** Deliberate bounded calculation: no ranking on each keystroke or silent truncation of the library. */
export function buildRadarRecommendations(entities:readonly VisibleEntity[],state:RadarState,topicId:string,scope:RadarQueueScope,at=Date.now()){
 const selected=entities.filter(e=>{if(e.entityType!=='paper'||e.deleted||!e.data)return false;const p=e.data as PaperData;return(!scope.tag||p.organization?.tags.includes(scope.tag))&&(!scope.collection||p.organization?.collections.includes(scope.collection));});
 if(selected.length>2000)throw new RadarError('LIMIT');let bytes=0;for(const e of selected){bytes+=new TextEncoder().encode(JSON.stringify(e.data)).length;if(bytes>4*1024*1024)throw new RadarError('LIMIT');}
 if(!state.topics.some(t=>t.id===topicId))throw new RadarError('CHANGED');return radarCore.buildQueue(radarLibrary(selected),state,topicId,at);
}
