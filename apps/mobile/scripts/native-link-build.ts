import {createHash} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,parse,posix,relative,resolve} from 'node:path';
import type {Plugin} from 'vite';
import {nativeLinkBinding,type NativeLinkPlatform} from '../src/auth/nativeLinks.ts';
import {normalizeServiceUrl} from '../src/config.ts';
import {androidNativeAssociation,iosNativeAssociation} from '../../../packages/sync-core/src/nativeLinks.ts';

export interface NativeBuildSettings {
  formatVersion:1;
  platform:NativeLinkPlatform;
  origin:string;
  apiBaseUrl:string;
  oidcAuthority:string;
}
function required(value:unknown,code:string):asserts value{if(!value)throw Error(code);}
function record(value:unknown):Record<string,unknown>{
  required(value&&typeof value==='object'&&!Array.isArray(value),'NATIVE_SETTINGS_INVALID');
  return value as Record<string,unknown>;
}
export function outsideRepository(path:string):string {
  const absolute=resolve(path),parent=existsSync(absolute)?realpathSync(absolute):realpathSync(dirname(absolute));
  for(const initial of [absolute,parent]){
    for(let current=initial;;current=dirname(current)){
      required(!existsSync(join(current,'.git')),'NATIVE_SETTINGS_OUTSIDE_GIT_REQUIRED');
      if(current===parse(current).root)break;
    }
  }
  return absolute;
}
function readDocument(path:string,limit=16384):unknown{
  required(lstatSync(path).isFile()&&!lstatSync(path).isSymbolicLink()&&lstatSync(path).size<=limit,'NATIVE_SETTINGS_INVALID');
  try{return JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('NATIVE_SETTINGS_INVALID');}
}
export function checkedNativeBuildSettings(value:unknown):NativeBuildSettings{
  const input=record(value);
  required(Object.keys(input).sort().join(',')==='apiBaseUrl,formatVersion,oidcAuthority,origin,platform'
    &&input.formatVersion===1&&['ios','android'].includes(String(input.platform)),'NATIVE_SETTINGS_INVALID');
  const binding=nativeLinkBinding(String(input.platform),String(input.origin));
  for(const key of ['apiBaseUrl','oidcAuthority']){
    const url=input[key];required(typeof url==='string'&&url.length<=2048&&normalizeServiceUrl(url)===url
      &&new URL(url).protocol==='https:','NATIVE_SETTINGS_INVALID');
  }
  return{formatVersion:1,platform:binding.platform,origin:binding.origin,apiBaseUrl:input.apiBaseUrl as string,oidcAuthority:input.oidcAuthority as string};
}
export function readNativeBuildSettings(path:string):NativeBuildSettings{
  return checkedNativeBuildSettings(readDocument(outsideRepository(path)));
}
export function readNativeInput(path:string):unknown{return readDocument(outsideRepository(path));}
function filesIn(root:string):string[]{
  const result:string[]=[];
  function visit(directory:string){
    for(const item of readdirSync(directory,{withFileTypes:true})){
      const path=join(directory,item.name);required(!item.isSymbolicLink(),'NATIVE_BUNDLE_INVALID');
      if(item.isDirectory())visit(path);
      else{required(item.isFile(),'NATIVE_BUNDLE_INVALID');result.push(relative(root,path).split('\\').join('/'));}
      required(result.length<=4096,'NATIVE_BUNDLE_TOO_LARGE');
    }
  }
  visit(root);return result.sort();
}
const hash=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
export function writeNativeBundleBinding(settings:NativeBuildSettings,folder:string):void{
  const checked=checkedNativeBuildSettings(settings),binding=nativeLinkBinding(checked.platform,checked.origin);
  const files=filesIn(folder).filter(name=>name!=='native-link-binding.json');
  required(files.includes('index.html')&&files.some(name=>/\.m?js$/.test(name)),'NATIVE_BUNDLE_INVALID');
  writeFileSync(join(folder,'native-link-binding.json'),JSON.stringify({formatVersion:1,...binding,
    files:Object.fromEntries(files.map(name=>[name,hash(join(folder,name))]))},null,2)+'\n',{mode:0o644});
}
/** Validate copied Web bytes against the same binding used by Vite and the OS. */
export function validateNativeBundle(platform:string,host:string,folder:string):{configured:boolean;filesVerified:number}{
  required(['ios','android'].includes(platform),'NATIVE_PLATFORM_INVALID');
  const path=join(folder,'native-link-binding.json');
  if(!existsSync(path)){
    required(host==='unconfigured.invalid','NATIVE_BUNDLE_BINDING_REQUIRED');
    return{configured:false,filesVerified:0};
  }
  const input=record(readDocument(path,1024**2));
  required(Object.keys(input).sort().join(',')==='clientId,files,formatVersion,logoutRedirectUri,origin,platform,redirectUri'
    &&input.formatVersion===1&&input.platform===platform,'NATIVE_BUNDLE_INVALID');
  const binding=nativeLinkBinding(platform,String(input.origin));
  required(new URL(binding.origin).hostname===host&&Object.entries(binding).every(([key,value])=>input[key]===value),'NATIVE_BUNDLE_HOST_MISMATCH');
  const files=record(input.files),names=Object.keys(files).sort();
  required(names.length>1&&names.length<=4096&&names.includes('index.html')&&names.some(name=>/\.m?js$/.test(name)),'NATIVE_BUNDLE_INVALID');
  for(const name of names){
    required(name===posix.normalize(name)&&!isAbsolute(name)&&!name.startsWith('.')&&!/[\\\x00-\x1f\x7f:]/.test(name)
      &&typeof files[name]==='string'&&/^[a-f0-9]{64}$/.test(files[name] as string),'NATIVE_BUNDLE_INVALID');
  }
  // Capacitor adds these runtime bridges after copying Vite's output.
  const bridges=['capacitor.js','capacitor_plugins.js','cordova.js','cordova_plugins.js'];
  const actual=filesIn(folder).filter(name=>name!=='native-link-binding.json'&&(!bridges.includes(name)||Object.hasOwn(files,name)));
  required(JSON.stringify(actual)===JSON.stringify(names),'NATIVE_BUNDLE_FILES_CHANGED');
  for(const name of names)required(hash(join(folder,name))===files[name],'NATIVE_BUNDLE_BYTES_CHANGED');
  return{configured:true,filesVerified:names.length};
}
export function nativeLinkBuildPlugin(settingsPath?:string):Plugin{
  const settings=settingsPath?readNativeBuildSettings(settingsPath):null;
  return{name:'paperquay-native-link-binding',apply:'build',enforce:'post',
    config(){
      if(!settings)return;
      const binding=nativeLinkBinding(settings.platform,settings.origin);
      return{define:Object.fromEntries(Object.entries({VITE_NATIVE_LINK_PLATFORM:binding.platform,VITE_NATIVE_LINK_ORIGIN:binding.origin,
        VITE_API_BASE_URL:settings.apiBaseUrl,VITE_OIDC_AUTHORITY:settings.oidcAuthority,VITE_OIDC_CLIENT_ID:binding.clientId})
        .map(([key,value])=>['import.meta.env.'+key,JSON.stringify(value)]))};
    },
    writeBundle(options){if(settings){required(options.dir,'NATIVE_BUNDLE_DIRECTORY_REQUIRED');writeNativeBundleBinding(settings,resolve(options.dir));}},
  };
}
/** Generate public association documents and disabled clients, never a proof of OS verification. */
export function prepareNativeLinks(value:unknown,platform:string,output:string):NativeBuildSettings{
  const input=record(value);
  required(Object.keys(input).every(key=>['formatVersion','origin','apiBaseUrl','oidcAuthority','ios','android'].includes(key)),'NATIVE_SETTINGS_INVALID');
  const settings=checkedNativeBuildSettings({formatVersion:input.formatVersion,platform,origin:input.origin,apiBaseUrl:input.apiBaseUrl,oidcAuthority:input.oidcAuthority});
  const binding=nativeLinkBinding(settings.platform,settings.origin),target=outsideRepository(output);
  required(!existsSync(target),'NATIVE_OUTPUT_EXISTS');
  let association:unknown,name:string;
  if(platform==='ios'){
    const ios=record(input.ios),prefix=ios.applicationIdentifierPrefix;
    required(Object.keys(ios).join(',')==='applicationIdentifierPrefix','NATIVE_IOS_IDENTIFIER_REQUIRED');
    name='apple-app-site-association';
    association=iosNativeAssociation(prefix);
  }else{
    const android=record(input.android),certificates=android.sha256CertificateFingerprints;
    required(Object.keys(android).join(',')==='sha256CertificateFingerprints','NATIVE_ANDROID_CERTIFICATE_REQUIRED');
    name='assetlinks.json';
    association=androidNativeAssociation(certificates);
  }
  mkdirSync(target,{mode:0o700});mkdirSync(join(target,'.well-known'),{mode:0o700});
  const write=(name:string,value:unknown)=>writeFileSync(join(target,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  write('native-build.settings.json',settings);write('.well-known/'+name,association);
  write('server-associations.settings.json',{PAPERQUAY_NATIVE_LINK_ORIGIN:binding.origin,
    ...(platform==='ios'?{PAPERQUAY_NATIVE_IOS_APPLICATION_IDENTIFIER_PREFIX:record(input.ios).applicationIdentifierPrefix}
      :{PAPERQUAY_NATIVE_ANDROID_CERTIFICATE_SHA256:(record(input.android).sha256CertificateFingerprints as string[]).join(',')})});
  writeFileSync(join(target,'NativeLinks.xcconfig'),'PAPERQUAY_NATIVE_LINK_HOST = '+new URL(binding.origin).hostname+'\n',{flag:'wx',mode:0o600});
  write('oidc-client.disabled.json',{clientId:binding.clientId,enabled:false,protocol:'openid-connect',publicClient:true,standardFlowEnabled:true,
    directAccessGrantsEnabled:false,implicitFlowEnabled:false,serviceAccountsEnabled:false,fullScopeAllowed:false,
    redirectUris:[binding.redirectUri],webOrigins:[platform==='ios'?'capacitor://localhost':'https://localhost'],defaultClientScopes:['basic','profile','email'],optionalClientScopes:['offline_access'],
    attributes:{'pkce.code.challenge.method':'S256','client.use.lightweight.access.token.enabled':'false','post.logout.redirect.uris':binding.logoutRedirectUri},
    protocolMappers:[{name:'paperquay-sync-audience',protocol:'openid-connect',protocolMapper:'oidc-audience-mapper',consentRequired:false,
      config:{'included.custom.audience':'paperquay-sync','access.token.claim':'true','id.token.claim':'false','lightweight.claim':'true'}}]});
  write('verification-required.json',{nativeClientsEnabled:false,signatureVerified:false,osDomainAssociationVerified:false,
    apiAllowedOriginsRequired:[platform==='ios'?'capacitor://localhost':'https://localhost'],apiClientIdsRequired:[binding.clientId]});
  return settings;
}
