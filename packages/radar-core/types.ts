export type RadarSource='crossref'|'openalex';
export type RankingKey='relevance'|'priority'|'methods'|'recency';
export type ReadingStatus='unread'|'later'|'read';
export interface RadarTopicConfig {name:string;queries:string[];includeTerms:string[];excludeTerms:string[];priorityTerms:string[];methodTerms:string[];sources:RadarSource[];lookbackDays:number;intervalHours:number;enabled:boolean;weights:Record<RankingKey,number>}
export interface RadarSourceReport {source:RadarSource;query:string;received:number;total:number;limited:boolean;error:string|null;retryAt?:number|null}
export interface RadarTopic extends RadarTopicConfig {id:string;revision:number;lastAttemptAt:number|null;lastSuccessAt:number|null;nextRunAt:number|null;retryAt:number|null;lastRun:{at:number;status:'success'|'partial'|'failed'|'cancelled';added:number;known:number;capacity:boolean;reports:RadarSourceReport[];message?:string}|null}
export interface PaperRanking {score:number;excluded:boolean;reasons:{key:RankingKey;points:number;max:number;matched:string[]}[]}
export interface RadarRecord {source:RadarSource;sourceId:string;title:string;authors:string[];year:string;doi:string;publication:string;url:string;abstractText:string;keywords:string[]}
export interface RadarCandidate extends RadarRecord {id:string;sources:RadarSource[];topicIds:string[];discoveredAt:number;lastSeenAt:number;dismissed:boolean;paperId:string|null}
export interface RadarQueueChoice {paperId:string;status?:ReadingStatus;pinned?:boolean}
export interface RadarPaper {id:string;title:string;authors:(string|{name:string})[];doi?:string|null;year?:string|null;abstractText?:string|null;keywords?:string[];tags?:({name:string}|string)[];attachments?:{kind:string;missing?:boolean}[];importedAt?:number;[key:string]:unknown}
export interface ReadingQueueItem<TPaper=RadarPaper> extends PaperRanking {paper:TPaper;pinned:boolean;status:ReadingStatus;evidence:'pdf-available'|'abstract'|'metadata'}
export interface RadarDomainState {topics:RadarTopic[];candidates:RadarCandidate[];queue:RadarQueueChoice[]}
