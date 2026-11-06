const path=require('node:path');
const nativeFs=require('./nativeFs.cjs');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail=code=>{throw Object.assign(new Error(code),{code});};
/** Called with a coordinator-owned snapshot; the renderer supplies only the invocation UUID. */
function createModelBackupExporter(options={}){
 const files=options.files||nativeFs;
 return{async save(backup,{event,check=()=>{}}={}){
  check();if(backup?.format!=='paperquay-computer-model-backup'||backup.version!==1||!UUID.test(backup.record?.id))fail('MODEL_BACKUP_INVALID');
  const bytes=Buffer.from(JSON.stringify(backup,null,2));if(bytes.length>1024*1024)fail('MODEL_BACKUP_TOO_LARGE');
  const settings={title:'备份模型请求与结果 / Back up model request and result',defaultPath:'PaperQuay-model-'+backup.record.id+'.json',filters:[{name:'PaperQuay model backup',extensions:['json']}]};
  let chosen;if(options.showSaveDialog)chosen=await options.showSaveDialog(settings);else{const {dialog,BrowserWindow}=require('electron'),window=event?.sender&&BrowserWindow.fromWebContents(event.sender);chosen=window?await dialog.showSaveDialog(window,settings):await dialog.showSaveDialog(settings);}
  check();if(chosen.canceled||!chosen.filePath)return{status:'cancelled'};const destination=chosen.filePath;
  if(!path.isAbsolute(destination)||destination.includes('\0'))fail('MODEL_BACKUP_SAVE_FAILED');
  try{const pinned=files.inspectSync(destination);if(pinned.linkPath||path.resolve(pinned.actual)!==path.resolve(destination))fail('MODEL_BACKUP_SAVE_FAILED');check();await files.write(destination,bytes,{mode:0o600});}catch(e){if(e?.code==='DESKTOP_OPERATION_CANCELLED')throw e;fail('MODEL_BACKUP_SAVE_FAILED');}
  return{status:'exported',bytes:bytes.length};
 }};
}
module.exports={createModelBackupExporter};
