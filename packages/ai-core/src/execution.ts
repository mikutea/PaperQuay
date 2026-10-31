import {AiError} from './errors.ts';
import type {AiModelExecution} from './types.ts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new AiError('CONFIG_INVALID');
 const descriptors=Object.getOwnPropertyDescriptors(value);if(Reflect.ownKeys(value).length!==keys.length||keys.some(k=>!Object.hasOwn(descriptors,k))||Object.values(descriptors).some(d=>!d.enumerable||!('value'in d)))throw new AiError('CONFIG_INVALID');return value as Record<string,unknown>;
}
/** Private execution reference only: never contains an address, key or a synchronization entity. */
export function validateAiModelExecution(input:unknown):AiModelExecution{
 const value=object(input,['version','target','profileRef']);if(value.version!==1)throw new AiError('CONFIG_INVALID');
 const targetValue=value.target;if(!targetValue||typeof targetValue!=='object')throw new AiError('CONFIG_INVALID');
 const descriptors=Object.getOwnPropertyDescriptors(targetValue),kind=descriptors.kind?.value;let target:AiModelExecution['target'];
 if(kind==='gateway'){object(targetValue,['kind']);target={kind:'gateway'};}
 else if(kind==='computer'){const p=object(targetValue,['kind','deviceId']);if(typeof p.deviceId!=='string'||!UUID.test(p.deviceId))throw new AiError('CONFIG_INVALID');target={kind:'computer',deviceId:p.deviceId};}
 else throw new AiError('CONFIG_INVALID');
 const ref=object(value.profileRef,['id','revision','digest']);if(typeof ref.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ref.id)||!Number.isSafeInteger(ref.revision)||Number(ref.revision)<1||typeof ref.digest!=='string'||!/^[0-9a-f]{64}$/.test(ref.digest))throw new AiError('CONFIG_INVALID');
 return{version:1,target,profileRef:{id:ref.id,revision:Number(ref.revision),digest:ref.digest}};
}
