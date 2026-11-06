import { validateEntityData, type AttachmentVersionData, type PaperData, type VisibleEntity } from '../../../../packages/sync-core/src/index.ts';
import { createParsedAiContext } from '../parsed/aiContext.ts';
import type { ParsedCache } from '../parsed/cache.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import { ResearchError, RESEARCH_LIMITS, splitResearchText, validateResearchSources, type ResearchSource } from './context.ts';
export interface ResearchSelection { paperId: string; versionId: string | null }
export function researchSelectionSignature(entities: readonly VisibleEntity[], selections: ResearchSelection[]): string {
  return JSON.stringify(selections.map(s=>[s,entities.find(e=>e.entityType==='paper'&&e.entityId===s.paperId)??null,
    s.versionId?entities.find(e=>e.entityType==='attachmentVersion'&&e.entityId===s.versionId)??null:null]));
}
export async function collectResearchSources(options: {
  entities: readonly VisibleEntity[]; selections: ResearchSelection[]; scope: AccountScope; cache: ParsedCache;
  signal?: AbortSignal; current(): boolean;
}): Promise<ResearchSource[]> {
  const selections=structuredClone(options.selections),entities=structuredClone(options.entities.filter(e=>selections.some(s=>e.entityType==='paper'&&e.entityId===s.paperId||e.entityType==='attachmentVersion'&&e.entityId===s.versionId))),sources:ResearchSource[]=[];
  function check(){if(options.signal?.aborted||!options.current())throw new ResearchError('CHANGED');}
  check();if(!selections.length||selections.length>RESEARCH_LIMITS.sources||new Set(selections.map(s=>s.paperId)).size!==selections.length)throw new ResearchError('LIMIT');
  for(const selection of selections){
    check();const entity=entities.find(e=>e.entityType==='paper'&&e.entityId===selection.paperId&&!e.deleted&&e.data);
    if(!entity)throw new ResearchError('CHANGED');const validated=validateEntityData('paper',entity.data);if(!validated.ok)throw new ResearchError('INVALID');
    const paper=validated.value as PaperData;
    if(selection.versionId===null){
      const body=['标题：'+paper.title,'作者：'+paper.authors.join('；'),'年份：'+(paper.year??'未填写'),'来源：'+(paper.publication??'未填写'),
        'DOI：'+(paper.doi??'未填写'),'关键词：'+paper.keywords.join('；'),'摘要：'+(paper.abstractText??'未填写')].join('\n');
      sources.push({paperId:entity.entityId,title:paper.title,revision:entity.revision,kind:'metadata',attachmentVersionId:null,sha256:null,packageDigest:null,totalPages:null,chunks:splitResearchText(body,null)});
    }else{
      const version=entities.find(e=>e.entityType==='attachmentVersion'&&e.entityId===selection.versionId&&!e.deleted&&e.data);
      if(!version)throw new ResearchError('CHANGED');const checked=validateEntityData('attachmentVersion',version.data);if(!checked.ok)throw new ResearchError('INVALID');
      const data=checked.value as AttachmentVersionData;
      if(data.paperId!==selection.paperId||data.pageCount===null)throw new ResearchError('INVALID');
      const pdf={entityId:version.entityId,data};
      const cached=await options.cache.read(options.scope,pdf,data.pageCount,{signal:options.signal,guard:options.current});check();
      if(!cached)throw new ResearchError('EMPTY');
      const context=await createParsedAiContext(cached,pdf,data.pageCount,{scope:'document'});check();
      const chunks=context.pages.flatMap(page=>splitResearchText(page.text,page.pageIndex));
      sources.push({paperId:entity.entityId,title:paper.title,revision:entity.revision,kind:'parsed',attachmentVersionId:version.entityId,sha256:data.sha256,packageDigest:cached.digest,totalPages:data.pageCount,chunks});
    }
  }
  check();return validateResearchSources(sources);
}
