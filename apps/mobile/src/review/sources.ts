import {canonicalJson,listVisibleEntities,validateEntityData,type AttachmentVersionData,type PaperData,type NoteData,type VisibleEntity} from '../../../../packages/sync-core/src/index.ts';
import {richNoteText,type RichNoteData} from '../../../../packages/sync-core/src/richNote.ts';
import type {ParsedAsset} from '../../../../packages/sync-core/src/parsedDocument.ts';
import {getParsedCache,type ParsedCache} from '../parsed/cache.ts';
import {parsedBlockText,parsedMarkdownText} from '../parsed/aiContext.ts';
import {resolveParsedBlocks} from '../parsed/resolve.ts';
import type {AccountScope} from '../storage/accountStore.ts';
import {ReviewError,REVIEW_LIMITS,reviewEntitySignature,type ReviewSelection,type ReviewSource,type ReviewProject} from './model.ts';
import type {ReviewContextItem,ReviewFigureCandidate} from './core.ts';
export interface ReviewSourceBundle {sources:ReviewSource[];assets:Map<string,ParsedAsset>}
export function reviewSelectionsSignature(entities:readonly VisibleEntity[],selections:ReviewSelection[]):string{return reviewEntitySignature(entities,selections);}
export async function collectReviewSources(input:{entities:readonly VisibleEntity[];selections:ReviewSelection[];scope:AccountScope;cache?:ParsedCache;signal?:AbortSignal;current():boolean}):Promise<ReviewSourceBundle>{
 const selections=structuredClone(input.selections),entities=structuredClone(input.entities),sources:ReviewSource[]=[],assets=new Map<string,ParsedAsset>();let paperIndex=0,noteIndex=0;
 const check=()=>{if(input.signal?.aborted||!input.current())throw new ReviewError('CHANGED');};check();
 if(!selections.length||selections.length>REVIEW_LIMITS.sources||new Set(selections.map(s=>s.kind+':'+s.id)).size!==selections.length)throw new ReviewError('LIMIT');
 for(const selection of selections){
  check();const entity=entities.find(e=>e.entityType===selection.kind&&e.entityId===selection.id&&!e.deleted&&e.data);if(!entity)throw new ReviewError('CHANGED');
  const validated=validateEntityData(selection.kind,entity.data);if(!validated.ok)throw new ReviewError('INVALID');
  const id=selection.kind==='paper'?'P'+(++paperIndex):'N'+(++noteIndex);let total=0,prefix='',kind:ReviewSource['kind']='note',packageDigest:string|null=null;
  const pages=new Set<number>(),figures:ReviewFigureCandidate[]=[],figureAssets:ReviewSource['figureAssets']=[];
  function append(value:string,page?:number){if(!value.trim())return;const chunk=(total?'\n\n':'')+value;total+=chunk.length;if(total>2_000_000)throw new ReviewError('LIMIT');const remaining=REVIEW_LIMITS.contextCharacters-prefix.length;if(remaining>0){prefix+=chunk.slice(0,remaining);if(page!==undefined)pages.add(page);}}
  let context:ReviewContextItem;
  if(selection.kind==='paper'){
   const paper=validated.value as PaperData;context={id,sourceType:'paper',paperId:entity.entityId,title:paper.title,authors:paper.authors.join('; '),year:paper.year??'',journal:paper.publication??'',doi:paper.doi??'',text:'',figures};
   if(selection.versionId===null){kind='metadata';append(['Title: '+paper.title,paper.abstractText?'Abstract: '+paper.abstractText:'',paper.keywords.length?'Keywords: '+paper.keywords.join(', '):''].filter(Boolean).join('\n'));}
   else{
    kind='parsed';const entityVersion=entities.find(e=>e.entityType==='attachmentVersion'&&e.entityId===selection.versionId&&!e.deleted&&e.data);if(!entityVersion)throw new ReviewError('CHANGED');
    const checked=validateEntityData('attachmentVersion',entityVersion.data);if(!checked.ok)throw new ReviewError('INVALID');const version=checked.value as AttachmentVersionData;if(version.paperId!==entity.entityId||!version.pageCount)throw new ReviewError('INVALID');
    const verified=await(input.cache??getParsedCache()).read(input.scope,{entityId:entityVersion.entityId,data:version},version.pageCount,{signal:input.signal,guard:input.current});check();if(!verified)throw new ReviewError('INCOMPLETE');packageDigest=verified.digest;
    const available=new Map(verified.document.assets.map(a=>[a.id,a]));
    for(const block of resolveParsedBlocks(verified.document)){
     append(parsedBlockText(block),block.pageIndex);
     if(block.kind==='image'&&block.assetId&&figures.length<6){const asset=available.get(block.assetId);if(!asset)throw new ReviewError('FIGURE');const figureId=id+'-F'+(figures.length+1);
      figures.push({id:figureId,sourceId:id,sourceTitle:paper.title,caption:(block.caption||block.text||'图 '+(figures.length+1)).slice(0,2048),path:'review-asset:'+figureId,kind:'image',pageIndex:block.pageIndex,blockId:block.id});
      figureAssets.push({id:figureId,assetId:asset.id,sha256:asset.sha256,mediaType:asset.mediaType});assets.set(figureId,asset);
     }
    }
   }
  }else{
   if(selection.versionId!==null)throw new ReviewError('INVALID');const note=validated.value as NoteData;context={id,sourceType:'note',noteId:entity.entityId,...(note.paperId?{paperId:note.paperId}:{}),title:note.title,text:'',figures:[]};
   append(note.format==='markdown'?parsedMarkdownText(note.body):richNoteText((note as RichNoteData).document));
  }
  prefix=prefix.trimEnd();if(!prefix.trim())throw new ReviewError('INCOMPLETE');context.text=prefix;
  sources.push({selection,entitySignature:reviewEntitySignature(entities,[selection]),context,kind,packageDigest,totalCharacters:total,omittedCharacters:total-prefix.length,pages:[...pages].sort((a,b)=>a-b),figureAssets});
 }
 check();return{sources,assets};
}
/** Reopening a capture never sends a model request or silently substitutes a different version. */
export async function revalidateReviewProject(project:ReviewProject,input:Omit<Parameters<typeof collectReviewSources>[0],'selections'>):Promise<ReviewSourceBundle>{
 const bundle=await collectReviewSources({...input,selections:project.sources.map(s=>s.selection)});
 if(canonicalJson(bundle.sources)!==canonicalJson(project.sources))throw new ReviewError('CHANGED');return bundle;
}
