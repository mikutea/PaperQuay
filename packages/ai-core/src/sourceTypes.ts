import type {AnnotationAnchor,PdfQuad} from '../../sync-core/src/types.ts';
export interface ParsedAiTextSource {kind:'parsed-document';packageDigest:string;parserName:'mineru';parserModel:string}
export interface PdfAiContext {paperId:string;attachmentVersionId:string;sha256:string;scope:'selection'|'page'|'document';totalPages:number;pages:{pageIndex:number;text:string;anchor?:AnnotationAnchor}[];complete:boolean;label:string;textSource?:ParsedAiTextSource}
export interface PdfCitationTarget {requestId:string;attachmentVersionId:string;sha256:string;pageIndex:number;quads?:PdfQuad[]}
