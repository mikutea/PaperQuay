import { ClientError } from './errors.ts';

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

export function parseAppConfig(input: PublicConfigInput, pageOrigin: string, native = false): AppConfig {
  if (!input.apiBaseUrl?.trim() || !input.oidcAuthority?.trim() || !input.oidcClientId?.trim()) {
    throw new ClientError('CONFIG_MISSING');
  }
  const origin = native ? '' : normalizeServiceUrl(pageOrigin);
  if (!native && new URL(origin).pathname !== '/') throw new ClientError('CONFIG_INVALID');
  const clientId = input.oidcClientId.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(clientId)) throw new ClientError('CONFIG_INVALID');
  return {
    apiBaseUrl: normalizeServiceUrl(input.apiBaseUrl.trim()),
    oidcAuthority: normalizeServiceUrl(input.oidcAuthority.trim()),
    oidcClientId: clientId,
    redirectUri: native ? NATIVE_REDIRECT_URI : `${origin}/auth/callback`,
    logoutRedirectUri: native ? NATIVE_LOGOUT_URI : `${origin}/`,
  };
}
