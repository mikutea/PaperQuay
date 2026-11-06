import type {FastifyInstance,onRequestHookHandler} from 'fastify';
import {androidNativeAssociation,checkedNativeLinkBinding,iosNativeAssociation} from '../../packages/sync-core/src/nativeLinks.ts';
import {ApiError} from './errors.ts';

export interface NativeAssociations {
  origin:string;
  ios:ReturnType<typeof iosNativeAssociation>|null;
  android:ReturnType<typeof androidNativeAssociation>|null;
}
/** Public signature identifiers only. Enabling an OAuth client is a separate,
 * explicit operator action after signed build and OS verification. */
export function loadNativeAssociations(env:NodeJS.ProcessEnv):NativeAssociations|null{
  const origin=env.PAPERQUAY_NATIVE_LINK_ORIGIN,ios=env.PAPERQUAY_NATIVE_IOS_APPLICATION_IDENTIFIER_PREFIX,
    android=env.PAPERQUAY_NATIVE_ANDROID_CERTIFICATE_SHA256;
  if(origin===undefined&&ios===undefined&&android===undefined)return null;
  try{
    if(!origin||!ios&&!android||ios!==undefined&&!ios||android!==undefined&&!android||android&&android.length>383)throw Error();
    const binding=checkedNativeLinkBinding('ios',origin);
    return{origin:binding.origin,ios:ios?iosNativeAssociation(ios):null,android:android?androidNativeAssociation(android.split(',')):null};
  }catch{throw new ApiError('CONFIGURATION_INVALID',500);}
}
export function registerNativeAssociationRoutes(app:FastifyInstance,settings:NativeAssociations|null|undefined,limit:onRequestHookHandler):void{
  for(const [path,platform] of [['/.well-known/apple-app-site-association','ios'],['/.well-known/assetlinks.json','android']] as const){
    app.get(path,{onRequest:limit},async(request,reply)=>{
      const document=settings?.[platform];
      if(!settings||!document||request.hostname.toLowerCase()!==new URL(settings.origin).hostname)throw new ApiError('NOT_FOUND',404);
      return reply.type('application/json').send(document);
    });
  }
}
