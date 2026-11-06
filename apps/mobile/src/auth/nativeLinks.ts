import {ClientError} from '../errors.ts';

export type NativeLinkPlatform='ios'|'android';
export interface NativeLinkBinding {
  readonly platform:NativeLinkPlatform;
  readonly origin:string;
  readonly clientId:string;
  readonly redirectUri:string;
  readonly logoutRedirectUri:string;
}

/** Public build metadata, configured outside Git. This is not evidence that
 * an installed OS has verified the website and the actual release signature. */
export function nativeLinkBinding(platform:string,origin:string):NativeLinkBinding {
  try{
    if(!['ios','android'].includes(platform)||typeof origin!=='string'||origin.length>2048)throw Error();
    const url=new URL(origin);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(url.hostname)||
      url.hostname==='localhost'||url.hostname.endsWith('.localhost')||origin!==url.origin)throw Error();
    const path=url.origin+'/auth/native/'+platform;
    return Object.freeze({platform:platform as NativeLinkPlatform,origin:url.origin,clientId:'paperquay-'+platform,
      redirectUri:path+'/callback',logoutRedirectUri:path+'/logout'});
  }catch{throw new ClientError('CONFIG_INVALID');}
}

export function nativeLinksFromEnvironment(platform:string,environment:Readonly<Record<string,unknown>>):NativeLinkBinding|null {
  const origin=environment.VITE_NATIVE_LINK_ORIGIN,target=environment.VITE_NATIVE_LINK_PLATFORM;
  if(origin===undefined&&target===undefined)return null;
  if(typeof origin!=='string'||typeof target!=='string'||target!==platform)throw new ClientError('CONFIG_INVALID');
  return nativeLinkBinding(target,origin);
}
