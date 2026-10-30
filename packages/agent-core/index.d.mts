import type{AgentTool,AgentPaper,AgentUpdate,AgentPlan,RenameOperation,AgentMetadata}from'./types.ts';export type*from'./types.ts';
export interface AgentPlanCore{
 newPlanId(tool:AgentTool):string;normalizeComparable(value:string):string;stripKnownReadPrefix(title:string):string;normalizeAgentTagName(value:string):string;uniqueTags(tags:string[]):string[];paperAuthors(paper:AgentPaper):string[];
 metadataUpdateForPaper(paper:AgentPaper,metadata:AgentMetadata):AgentUpdate|null;
 parseRenameCommand(command:string):RenameOperation|null;buildRenamePlan(papers:AgentPaper[],operation:RenameOperation):AgentPlan;
 inferSmartTagsForPaper(paper:AgentPaper):string[];inferCollectionNameForPaper(paper:AgentPaper):string;buildSmartTagPlan(papers:AgentPaper[]):AgentPlan;buildCleanTagsPlan(papers:AgentPaper[]):AgentPlan;buildAutoClassifyPlan(papers:AgentPaper[]):AgentPlan;
}
export function createAgentPlanCore(adapters?:{now?:()=>number;random?:()=>number}):AgentPlanCore;
