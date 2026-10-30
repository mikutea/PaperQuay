export type AgentTool='rename'|'metadata'|'smart-tags'|'clean-tags'|'classify';
export type RenameOperation={mode:'prefix';value:string}|{mode:'suffix';value:string}|{mode:'replace';from:string;to:string};
export interface AgentPaper{id:string;title:string;authors:{name:string}[];year:string|null;publication:string|null;doi:string|null;url:string|null;abstractText:string|null;keywords:string[];tags:{name:string}[];categoryIds:string[]}
export interface AgentUpdate{paperId:string;title?:string|null;year?:string|null;publication?:string|null;doi?:string|null;url?:string|null;abstractText?:string|null;authors?:string[]|null;keywords?:string[]|null;tags?:string[]|null}
export interface AgentPlanItem{id:string;tool:AgentTool;paperId:string;paperTitle:string;title:string;description:string;before?:string;after?:string;updateRequest?:AgentUpdate;targetCategoryName?:string;targetCategoryParentName?:string;metadataSource?:string}
export interface AgentPlan{id:string;tool:AgentTool;title:string;description:string;items:AgentPlanItem[];createdAt:number}
export interface AgentMetadata{authors:string[];title?:string|null;year?:string|null;publication?:string|null;doi?:string|null;url?:string|null;abstractText?:string|null}
