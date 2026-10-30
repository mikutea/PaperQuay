import type {RadarTopicConfig,RadarTopic,RadarRecord,RadarCandidate,RadarPaper,RadarDomainState,PaperRanking,ReadingQueueItem}from'./types.ts';
export type * from './types.ts';
export interface RadarCore {
 DAY_MS:number;DEFAULT_WEIGHTS:RadarTopicConfig['weights'];SOURCES:('crossref'|'openalex')[];
 normalizeTopic(input:unknown,previous?:RadarTopic):RadarTopic;normalizeDoi(value:unknown):string;publicUrl(value:unknown):string;
 mapWork(source:'crossref'|'openalex',item:unknown):RadarRecord|null;
 candidateKey(paper:Partial<RadarRecord>):string;candidatePaperId(candidateId:string):string;
 samePaper(left:Partial<RadarPaper>,right:Partial<RadarPaper>):boolean;
 createPaperIndex<T extends {id:string}>(papers:T[]):{add(paper:T):void;byId:Map<string,T>;find(paper:unknown):T|undefined};
 topicAccepts(paper:unknown,topic:RadarTopicConfig):boolean;rankPaper(paper:unknown,topic:RadarTopicConfig,timestamp?:number):PaperRanking;
 buildQueue<T extends RadarPaper>(library:{papers:T[]},state:RadarDomainState,topicId:string,timestamp?:number):ReadingQueueItem<T>[];
 mergeCandidates(state:RadarDomainState,records:RadarRecord[],topic:RadarTopic,timestamp:number,library:{papers:RadarPaper[]}):{added:number;known:number;capacity:boolean};
 [key:string]:any;
}
export function createRadarCore(adapters:{hash:(value:string)=>string;randomUUID:()=>string}):RadarCore;
