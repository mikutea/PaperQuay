import {inspectParsedImage,type ParsedAsset} from '../../../../packages/sync-core/src/parsedDocument.ts';
import {ReviewError,validateReviewProject,composeReviewProject,type ReviewProject} from './model.ts';
import type {ReviewJsonFigure} from './core.ts';
export interface ReviewWordResult {bytes:Uint8Array;markdown:string;skippedFigures:{index:number;id:string;reason:string}[];validation:{status:string;errors:string[];warnings:string[];imageCount:number;formulaCount:number;paragraphCount:number}}
async function pngFromWebp(bytes:Uint8Array,current:()=>boolean):Promise<Uint8Array>{
 const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/webp'}));try{
  if(!current())throw new ReviewError('CHANGED');if(bitmap.width*bitmap.height>16*1024*1024)throw new ReviewError('LIMIT');
  const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;const context=canvas.getContext('2d');if(!context)throw new ReviewError('FIGURE');context.drawImage(bitmap,0,0);
  try{const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new ReviewError('FIGURE')),'image/png'));if(blob.size>4*1024*1024)throw new ReviewError('LIMIT');if(!current())throw new ReviewError('CHANGED');return new Uint8Array(await blob.arrayBuffer());}
  finally{canvas.width=0;canvas.height=0;}
 }finally{bitmap.close();}
}
export async function renderReviewWord(input:ReviewProject,assets:ReadonlyMap<string,ParsedAsset>,current:()=>boolean):Promise<ReviewWordResult>{
 const check=()=>{if(!current())throw new ReviewError('CHANGED');};check();const project=validateReviewProject(input),draft=composeReviewProject(project);
 // Loaded only for an explicit Word preview/export, not when opening the app or editor.
 const {createMobileWordCore}=await import('./wordCore.cjs');check();
 const expected=new Map(project.sources.flatMap(s=>s.figureAssets.map(a=>[a.id,a] as const)));
 const read=async(figure:ReviewJsonFigure)=>{check();const owned=expected.get(figure.id),asset=assets.get(figure.id);if(!owned||!asset||asset.id!==owned.assetId||asset.sha256!==owned.sha256||asset.mediaType!==owned.mediaType||figure.path!=='review-asset:'+figure.id)throw new ReviewError('FIGURE');
  const binary=atob(asset.base64),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(bytes.length!==asset.sizeBytes)throw new ReviewError('FIGURE');const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(n=>n.toString(16).padStart(2,'0')).join('');check();if(digest!==asset.sha256)throw new ReviewError('FIGURE');
  const info=inspectParsedImage(bytes);if(info.mediaType!==asset.mediaType||info.width!==asset.width||info.height!==asset.height)throw new ReviewError('FIGURE');
  if(info.mediaType==='image/webp')return{imageBuffer:await pngFromWebp(bytes,current),extension:'png' as const};return{imageBuffer:bytes,extension:info.mediaType==='image/png'?'png' as const:'jpeg' as const};};
 const result=await createMobileWordCore(read).renderReviewPackage({data:{...draft,outputLanguage:project.settings.outputLanguage}});check();
 if(result.bytes.byteLength>16*1024*1024)throw new ReviewError('LIMIT');
 // A missing/corrupt image is an explicit receipt; the UI must review it before external sharing.
 return result;
}
