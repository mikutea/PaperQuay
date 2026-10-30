import{reviewCore}from'./core.ts';import{validateReviewProject,composeReviewProject,reviewSlots,type ReviewProject}from'./model.ts';
/** The desktop Markdown is an intermediate document with local figure locators.
 * A text export keeps the exact formal citations/captions without shipping broken private URLs. */
export function reviewTextMarkdown(input:ReviewProject):string{
 const project=validateReviewProject(input),draft=composeReviewProject(project,false),data=reviewCore.prepareReviewDocxData(draft,project.settings.outputLanguage),ids=new Set(draft.figures.map(f=>f.id));
 const seen=new Set<object>();function captions(value:unknown){if(!value||typeof value!=='object'||seen.has(value))return;seen.add(value);const item=value as Record<string,unknown>;if(item.kind==='image'&&typeof item.id==='string'&&ids.has(item.id)&&item.path==='review-asset:'+item.id)item.path='';for(const child of Object.values(item))captions(child);}captions(data);
 const slots=reviewSlots(project),completed=slots.filter(s=>s.part).length,notes:string[]=[];if(completed!==slots.length)notes.push('本文为未完成草稿：'+completed+'/'+slots.length+'段已保存。');if(draft.figures.length)notes.push('此 Markdown 包含文字与图注，不包含图片像素；请使用 Word 导出保留图片。');
 return(notes.length?notes.join('\n\n')+'\n\n':'')+reviewCore.renderPreparedReviewMarkdown(data,project.settings.outputLanguage);
}
