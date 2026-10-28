import {createRichNoteData} from '../../packages/sync-core/src/richNote.ts';
import {createAiConversation} from '../../packages/ai-core/src/conversation.ts';
import {validateAiArchiveItem,type AiHistoryRecord} from '../../packages/ai-core/src/archiveTypes.ts';
export const extendedId=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function richFixture(paperId:string|null=null){return createRichNoteData({paperId,title:'结构笔记',document:{type:'doc',content:[
  {type:'heading',attrs:{level:2},content:[{type:'text',text:'研究记录'}]},
  {type:'paragraph',content:[{type:'text',text:'保存完整的 '},{type:'text',text:'结构',marks:[{type:'bold'}]}]},
  {type:'bulletList',content:[{type:'listItem',content:[{type:'paragraph',content:[{type:'text',text:'一项证据'}]}]}]},
  {type:'blockMath',attrs:{latex:'E=mc^2'}},
]},metadata:{type:'standalone',anchors:[],tags:['方法'],color:'default',isFavorite:false,isPinned:false,
  linkedNoteIds:[],linkedPaperIds:[],createdAt:1,updatedAt:2,unresolvedReferences:[]},assets:[]});}
export function conversationFixture(paperId=extendedId(90),attachmentVersionId=extendedId(91)){
  const item=validateAiArchiveItem({kind:'record',version:1,id:extendedId(92),revision:1,createdAt:'2026-10-28T00:00:00.000Z',updatedAt:'2026-10-28T00:00:01.000Z',
    context:{paperId,attachmentVersionId,sha256:'a'.repeat(64),scope:'page',totalPages:8,pages:[{pageIndex:0,text:'合成原文'}],complete:true,label:'合成研究'},
    action:'ask',question:'如何理解这份材料？',provider:{id:'primary',endpoint:'https://model.example.invalid/v1',model:'synthetic'},
    result:{text:'合成回答 [P1]',status:'complete',finishReason:'stop',usage:null,cost:'unknown',failure:null}}) as AiHistoryRecord;
  return createAiConversation(item);
}
