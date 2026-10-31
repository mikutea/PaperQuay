const path=require('node:path');
const nativeFs=require('./nativeFs.cjs');
// Durable and unconfirmed snapshots each have a 16 MiB private-state limit.
const MAX_BACKUP_BYTES=32*1024*1024+4096;
const fail=code=>{throw Object.assign(new Error(code),{code});};
/** Receives a coordinator-owned graph snapshot; the renderer supplies no path or backup payload. */
function createGraphBackupExporter(options={}){
 const files=options.files||nativeFs;
 return{async save(backup,{event,check=()=>{}}={}){
  check();if(backup?.format!=='paperquay-desktop-graph-backup'||backup.version!==1)fail('DESKTOP_GRAPH_BACKUP_INVALID');
  const bytes=Buffer.from(JSON.stringify(backup));if(bytes.length>MAX_BACKUP_BYTES)fail('DESKTOP_GRAPH_BACKUP_TOO_LARGE');
  const settings={title:'备份账号关系 / Back up account graph relations',defaultPath:'PaperQuay-graph-'+new Date().toISOString().slice(0,10)+'.json',filters:[{name:'PaperQuay graph backup',extensions:['json']}]};
  let chosen;if(options.showSaveDialog)chosen=await options.showSaveDialog(settings);else{const{dialog,BrowserWindow}=require('electron'),window=event?.sender&&BrowserWindow.fromWebContents(event.sender);chosen=window?await dialog.showSaveDialog(window,settings):await dialog.showSaveDialog(settings);}
  check();if(chosen.canceled||!chosen.filePath)return{status:'cancelled'};const destination=chosen.filePath;
  if(!path.isAbsolute(destination)||destination.includes('\0'))fail('DESKTOP_GRAPH_BACKUP_SAVE_FAILED');
  try{const pinned=files.inspectSync(destination);if(pinned.linkPath||path.resolve(pinned.actual)!==path.resolve(destination))fail('DESKTOP_GRAPH_BACKUP_SAVE_FAILED');}catch{fail('DESKTOP_GRAPH_BACKUP_SAVE_FAILED');}
  check();try{await files.write(destination,bytes,{mode:0o600});}catch{fail('DESKTOP_GRAPH_BACKUP_SAVE_FAILED');}
  return{status:'exported',bytes:bytes.length};
 }};
}
module.exports={createGraphBackupExporter,MAX_BACKUP_BYTES};
