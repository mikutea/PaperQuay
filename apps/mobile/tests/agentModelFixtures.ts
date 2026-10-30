import {captureAgentTargets} from '../src/agent/proposals.ts';
import {prepareAgentModelRequest} from '../src/agent/modelProtocol.ts';
import {defaultAiProvider} from '../src/ai/provider.ts';
import {entities,id,paper} from './reviewFixtures.ts';
export {entities,id,scope,paper,now,deferred,tickUntil,completion} from './reviewFixtures.ts';
export const targets=()=>captureAgentTargets(entities,[id(2)]);
export const config=()=>({...defaultAiProvider(),id:'agent-fixture',endpoint:'https://agent-model.example.test/v1',model:'fixture-model',requiresKey:false,stream:false});
export const request=()=>prepareAgentModelRequest({conversationId:id(80),id:id(81),createdAt:1793359753000,tool:'auto',instruction:'核对所选文献题录',targets:targets(),contexts:[],history:[]});
export function planResponse(title='Suggested title'){return JSON.stringify({kind:'plan',plan:{tool:'rename',summary:'建议改名',items:[{paperId:id(2),title:'建议核对新标题',description:'模型建议，未应用',before:paper.title,after:title,update:{title}}]}});}
