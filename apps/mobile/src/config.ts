import { ClientError } from './errors.ts';
import {Capacitor} from '@capacitor/core';
import {nativeLinkBinding,nativeLinksFromEnvironment,type NativeLinkBinding} from './auth/nativeLinks.ts';

export const PUBLIC_CONFIG_STORAGE_KEY = 'paperquay.mobile.public-config.v1';

export interface PublicConfigInput {
  apiBaseUrl?: string;
  oidcAuthority?: string;
  oidcClientId?: string;
}

export interface AppConfig {
  apiBaseUrl: string;
  oidcAuthority: string;
  oidcClientId: string;
  redirectUri: string;
  logoutRedirectUri: string;
}

export function normalizeServiceUrl(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new ClientError('CONFIG_INVALID');
  }
}

export const NATIVE_REDIRECT_URI = 'dev.paperquay.mobile://auth/callback';
export const NATIVE_LOGOUT_URI = 'dev.paperquay.mobile://auth/logout';

export function configuredNativeLinks():NativeLinkBinding|null {
  return nativeLinksFromEnvironment(Capacitor.getPlatform(),import.meta.env??{});
}

export function nativeRedirects(config:Pick<AppConfig,'apiBaseUrl'|'oidcAuthority'|'oidcClientId'>,
  binding:NativeLinkBinding|null,production:boolean):Pick<AppConfig,'redirectUri'|'logoutRedirectUri'> {
  if(binding){
    try{
      const expected=nativeLinkBinding(binding.platform,binding.origin);
      if(Object.keys(binding).sort().join(',')!=='clientId,logoutRedirectUri,origin,platform,redirectUri'||
        Object.entries(expected).some(([key,value])=>binding[key as keyof NativeLinkBinding]!==value)||config.oidcClientId!==expected.clientId||
        new URL(config.apiBaseUrl).protocol!=='https:'||new URL(config.oidcAuthority).protocol!=='https:')throw Error();
      return{redirectUri:expected.redirectUri,logoutRedirectUri:expected.logoutRedirectUri};
    }catch{throw new ClientError('CONFIG_INVALID');}
  }
  if(production)throw new ClientError('NATIVE_LINKS_REQUIRED');
  return{redirectUri:NATIVE_REDIRECT_URI,logoutRedirectUri:NATIVE_LOGOUT_URI};
}

export function parseAppConfig(input: PublicConfigInput, pageOrigin: string, native = false,nativeLinks?:NativeLinkBinding|null): AppConfig {
  if (!input.apiBaseUrl?.trim() || !input.oidcAuthority?.trim() || !input.oidcClientId?.trim()) {
    throw new ClientError('CONFIG_MISSING');
  }
  const origin = native ? '' : normalizeServiceUrl(pageOrigin);
  if (!native && new URL(origin).pathname !== '/') throw new ClientError('CONFIG_INVALID');
  const clientId = input.oidcClientId.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(clientId)) throw new ClientError('CONFIG_INVALID');
  const config={
    apiBaseUrl: normalizeServiceUrl(input.apiBaseUrl.trim()),
    oidcAuthority: normalizeServiceUrl(input.oidcAuthority.trim()),
    oidcClientId: clientId,
  };
  return {...config,...(native?nativeRedirects(config,nativeLinks===undefined?configuredNativeLinks():nativeLinks,import.meta.env?.PROD===true)
    :{redirectUri:`${origin}/auth/callback`,logoutRedirectUri:`${origin}/`})};
}
