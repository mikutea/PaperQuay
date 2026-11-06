import {ClientError} from '../errors.ts';
import {checkedNativeLinkBinding,type NativeLinkBinding} from '../../../../packages/sync-core/src/nativeLinks.ts';
export type {NativeLinkPlatform,NativeLinkBinding} from '../../../../packages/sync-core/src/nativeLinks.ts';

/** Public build metadata, configured outside Git. This is not evidence that
 * an installed OS has verified the website and the actual release signature. */
export function nativeLinkBinding(platform:string,origin:string):NativeLinkBinding {
  try{return checkedNativeLinkBinding(platform,origin);}catch{throw new ClientError('CONFIG_INVALID');}
}

export function nativeLinksFromEnvironment(platform:string,environment:Readonly<Record<string,unknown>>):NativeLinkBinding|null {
  const origin=environment.VITE_NATIVE_LINK_ORIGIN,target=environment.VITE_NATIVE_LINK_PLATFORM;
  if(origin===undefined&&target===undefined)return null;
  if(typeof origin!=='string'||typeof target!=='string'||target!==platform)throw new ClientError('CONFIG_INVALID');
  return nativeLinkBinding(target,origin);
}
