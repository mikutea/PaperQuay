import type { ReviewBlueprint,ReviewBlueprintTask,ReviewContextItem,ReviewGeneratedPart,ReviewGeneratedPartsCheckpoint,ReviewJsonDraft,ReviewJsonFigure } from './types.ts';
export interface ReviewPromptOptions {intent:string;reviewType:string;targetAudience:string;outputLanguage:string;sourceScope?:string;contextItems:ReviewContextItem[]}
export interface ReviewMessage {role:string;content:string}
export interface ReviewWordValidation {status:'passed'|'warning'|'error';errors:string[];warnings:string[];paragraphCount:number;imageCount:number;formulaCount:number;markdownCharacterCount:number}
export interface ReviewImageBytes {imageBuffer:Uint8Array;extension:'png'|'jpeg'|'gif';imagePath?:string}
export interface ReviewCoreAdapters {
 PizZip?:new(...args:any[])=>any;Docxtemplater?:new(...args:any[])=>any;
 temml?:{renderToString(value:string,options:Record<string,unknown>):string};mathml2omml?:{mml2omml(value:string):string};DOMParser?:new(...args:any[])=>any;
 binaryType?:'uint8array'|'nodebuffer';readFigure?(figure:ReviewJsonFigure,index:number):Promise<ReviewImageBytes>;
 imageTargetPath?(target:string):string;warn?(message:string):void;
}
export interface ReviewRenderedPackage {bytes:Uint8Array;markdown:string;skippedFigures:{index:number;id:string;reason:string}[];validation:ReviewWordValidation}
export interface ReviewCore {
 normalizeReviewBlueprint(value:unknown,options?:Partial<ReviewPromptOptions>):ReviewBlueprint;
 normalizeReviewJsonDraft(value:unknown):ReviewJsonDraft;
 normalizeReviewContextItems(value:unknown):ReviewContextItem[];
 normalizeReviewFigures(value:unknown,sourceId?:string):ReviewJsonFigure[];
 buildReviewBlueprintPrompt(options:ReviewPromptOptions):ReviewMessage[];
 buildReviewPartPrompt(input:{options:ReviewPromptOptions;blueprint:ReviewBlueprint;kind:string;heading?:string;task:ReviewBlueprintTask;contextItems:ReviewContextItem[]}):ReviewMessage[];
 normalizeGeneratedReviewPart(value:unknown,task:ReviewBlueprintTask,validIds:Set<string>):ReviewGeneratedPart;
 normalizeReviewGeneratedParts(value:unknown,blueprint:ReviewBlueprint,validIds:Set<string>):ReviewGeneratedPartsCheckpoint;
 countCompletedReviewGeneratedParts(parts:ReviewGeneratedPartsCheckpoint):number;
 emptyReviewGeneratedPartsForBlueprint(blueprint:ReviewBlueprint):ReviewGeneratedPartsCheckpoint;
 mergeGeneratedParagraphParts(parts:Array<ReviewGeneratedPart|null>|undefined):ReviewGeneratedPart;
 composeReviewDraftFromGeneratedParts(input:{blueprint:ReviewBlueprint;contextItems:ReviewContextItem[];parts:ReviewGeneratedPartsCheckpoint&{sections:ReviewGeneratedPart[]}}):ReviewJsonDraft;
 normalizeReviewWritingConcurrency(value:unknown):number;reviewWritingTaskCount(blueprint:ReviewBlueprint):number;
 collectInternalCitationIds(text:string):string[];
 prepareReviewDocxData(value:ReviewJsonDraft,outputLanguage?:string):Record<string,any>;
 reviewDraftToMarkdown(value:ReviewJsonDraft,outputLanguage?:string):string;
 parseReviewMarkdownBlocks(value:string,options?:Record<string,unknown>):{kind:string;text:string;[key:string]:unknown}[];
 defaultReviewTemplateBuffer(outputLanguage?:string):Uint8Array;
 validateReviewDocxBuffer(bytes:Uint8Array,options?:{markdown?:string;strictContent?:boolean;expectedTitle?:string;expectedSectionHeadings?:string[]}):ReviewWordValidation;
 renderReviewPackage(input:{data:ReviewJsonDraft&{outputLanguage?:string};templateBytes?:Uint8Array;strictContent?:boolean}):Promise<ReviewRenderedPackage>;
 readImagePixelSize(bytes:Uint8Array,extension:string):{width:number;height:number};
 imageSizeEmu(bytes:Uint8Array,extension:string):{cx:number;cy:number};
 REVIEW_MAX_SECTION_COUNT:number;REVIEW_MAX_PARAGRAPHS_PER_SECTION:number;REVIEW_MAX_FIGURES_PER_REVIEW:number;REVIEW_MAX_CONTEXT_PER_TASK:number;
 REVIEW_CONTEXT_SUMMARY_CHAR_LIMIT:number;REVIEW_TASK_CONTEXT_CHAR_LIMIT:number;
}
/** Pure algorithms normalize legacy desktop data. Callers must validate untrusted
 * requests and exact source ownership before prompting or exporting. */
export function createReviewCore(adapters?:ReviewCoreAdapters):ReviewCore;
