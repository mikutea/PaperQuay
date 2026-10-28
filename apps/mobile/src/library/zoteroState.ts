import { validateZoteroConfig, validateZoteroCursor, zoteroSourceId, type ZoteroLibraryConfig } from './zoteroClient.ts';
export interface ZoteroLibraryState { version: 1; entries: { config: ZoteroLibraryConfig; cursor: number | null }[] }
const exact=(value:unknown,keys:string[]):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value)
  &&Object.keys(value).sort().join(',')===[...keys].sort().join(','));
export function validateZoteroLibraryState(value:unknown):ZoteroLibraryState{
  if(!exact(value,['version','entries'])||value.version!==1||!Array.isArray(value.entries)||value.entries.length>50)throw new Error('INVALID_ZOTERO_STATE');
  const seen=new Set<string>();
  const entries=value.entries.map(value=>{
    if(!exact(value,['config','cursor']))throw new Error('INVALID_ZOTERO_STATE');
    const config=validateZoteroConfig(value.config),cursor=validateZoteroCursor(value.cursor),key=zoteroSourceId(config);
    if(seen.has(key))throw new Error('INVALID_ZOTERO_STATE');seen.add(key);return{config,cursor};
  });return{version:1,entries};
}
export function zoteroCursor(state:ZoteroLibraryState|undefined,config:ZoteroLibraryConfig):number|null{
  const key=zoteroSourceId(config);return state?.entries.find(value=>zoteroSourceId(value.config)===key)?.cursor??null;
}
export function updateZoteroCursor(state:ZoteroLibraryState|undefined,input:ZoteroLibraryConfig,cursor:number|null):ZoteroLibraryState{
  const config=validateZoteroConfig(input),key=zoteroSourceId(config),current=state?validateZoteroLibraryState(state):{version:1 as const,entries:[]};
  const exists=current.entries.some(value=>zoteroSourceId(value.config)===key);
  return validateZoteroLibraryState({version:1,entries:exists?current.entries.map(value=>zoteroSourceId(value.config)===key?{config,cursor}:value):[...current.entries,{config,cursor}]});
}
