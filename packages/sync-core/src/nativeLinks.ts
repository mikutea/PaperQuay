/** Public, platform-specific claimed callback metadata. No signature or OS
 * verification is inferred from successfully parsing these values. */
export type NativeLinkPlatform='ios'|'android';
export interface NativeLinkBinding {
  readonly platform:NativeLinkPlatform;
  readonly origin:string;
  readonly clientId:string;
  readonly redirectUri:string;
  readonly logoutRedirectUri:string;
}
export function checkedNativeLinkBinding(platform:string,origin:string):NativeLinkBinding{
  try{
    if(!['ios','android'].includes(platform)||typeof origin!=='string'||origin.length>2048)throw Error();
    const url=new URL(origin);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||url.pathname!=='/'||url.hostname.length>253||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(url.hostname)||
      url.hostname==='localhost'||url.hostname.endsWith('.localhost')||url.hostname==='unconfigured.invalid'||origin!==url.origin)throw Error();
    const path=url.origin+'/auth/native/'+platform;
    return Object.freeze({platform:platform as NativeLinkPlatform,origin:url.origin,clientId:'paperquay-'+platform,
      redirectUri:path+'/callback',logoutRedirectUri:path+'/logout'});
  }catch{throw Error('NATIVE_LINK_CONFIG_INVALID');}
}
export function iosNativeAssociation(prefix:unknown){
  if(typeof prefix!=='string'||!/^[A-Z0-9]{10}$/.test(prefix))throw Error('NATIVE_IOS_IDENTIFIER_INVALID');
  return{applinks:{apps:[],details:[{appID:prefix+'.dev.paperquay.mobile',paths:['/auth/native/ios/callback','/auth/native/ios/logout']}]}};
}
export function androidNativeAssociation(certificates:unknown){
  if(!Array.isArray(certificates)||certificates.length<1||certificates.length>4||new Set(certificates).size!==certificates.length
    ||!certificates.every(value=>typeof value==='string'&&/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/.test(value)&&value!=='00:'.repeat(31)+'00'))throw Error('NATIVE_ANDROID_CERTIFICATE_INVALID');
  return[{relation:['delegate_permission/common.handle_all_urls'],target:{namespace:'android_app',package_name:'dev.paperquay.mobile',sha256_cert_fingerprints:[...certificates] as string[]}}];
}
