import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Log, OidcClient, User, type OidcClientSettings } from 'oidc-client-ts';
import { NATIVE_LOGOUT_URI, NATIVE_REDIRECT_URI, type AppConfig } from '../config.ts';
import { ClientError } from '../errors.ts';
import { createSecretStore, type SecretStore } from '../platform/secretStore.ts';
import type { AuthSession, AuthSnapshot, AuthSubject } from './oidc.ts';
import { SecureOidcStateStore, serializeSecret } from './secureStateStore.ts';

export interface NativeAuthBridge {
  open(url: string): Promise<void>;
  close(): Promise<void>;
  listen(listener: (url: string) => void): Promise<() => Promise<void>>;
  listenFinished?(listener: () => void): Promise<() => Promise<void>>;
  launchUrl(): Promise<string | undefined>;
}
export type NativeOidcProtocol = Pick<OidcClient, 'createSigninRequest' | 'processSigninResponse' | 'useRefreshToken' | 'createSignoutRequest' | 'processSignoutResponse'>;
interface NativeAuthOptions {
  secrets: SecretStore;
  bridge: NativeAuthBridge;
  protocol?: (settings: OidcClientSettings) => NativeOidcProtocol;
}

export function nativeAuthNamespace(config: AppConfig): string {
  return `paperquay.auth.v1:${JSON.stringify([config.apiBaseUrl, config.oidcAuthority, config.oidcClientId, config.redirectUri])}`;
}

function browserUrl(value: string): string {
  try {
    const url = new URL(value);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.hash) throw new Error();
    return url.toString();
  } catch { throw new ClientError('AUTH_FAILED'); }
}

export function nativeCallback(url: string, expected: string, logout = false): { state: string } {
  try {
    if (url.length > 16384) throw new Error();
    const callback = new URL(url);
    const target = new URL(expected);
    if (callback.protocol !== target.protocol || callback.host !== target.host || callback.pathname !== target.pathname ||
        callback.username || callback.password || callback.port || callback.hash) throw new Error();
    for (const key of callback.searchParams.keys()) {
      if (callback.searchParams.getAll(key).length !== 1 || ['access_token', 'id_token', 'refresh_token'].includes(key)) throw new Error();
    }
    const state = callback.searchParams.get('state');
    if (!state || !/^[A-Za-z0-9_-]{16,160}$/.test(state)) throw new Error();
    if (!logout) {
      const code = callback.searchParams.get('code');
      const error = callback.searchParams.get('error');
      if ((!code && !error) || (code && error) || (code?.length ?? 0) > 2048 || (error?.length ?? 0) > 256) throw new Error();
    }
    return { state };
  } catch { throw new ClientError('AUTH_FAILED'); }
}

/** Uses the system browser and OS secret storage; the WebView never hosts the sign-in page. */
export class NativeOidcSession implements AuthSession {
  private readonly namespace: string;
  private readonly states: SecureOidcStateStore;
  private user: User | null = null;
  private blockedCredentials = false;
  private snapshot: AuthSnapshot = { status: 'signed-out' };
  private listeners = new Set<() => void>();
  private epoch = 0;
  private disposed = false;
  private initialization?: Promise<void>;
  private unlisten?: () => Promise<void>;
  private unlistenFinished?: () => Promise<void>;
  private awaitingBrowser = false;
  private callbackTail: Promise<unknown> = Promise.resolve();
  private completedStates = new Set<string>();
  private refresh: Promise<string> | null = null;

  constructor(private readonly config: AppConfig, private readonly options: NativeAuthOptions) {
    if (config.redirectUri !== NATIVE_REDIRECT_URI || config.logoutRedirectUri !== NATIVE_LOGOUT_URI) throw new ClientError('CONFIG_INVALID');
    Log.setLevel(Log.NONE);
    this.namespace = nativeAuthNamespace(config);
    this.states = new SecureOidcStateStore(options.secrets, this.namespace);
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  getSnapshot = (): AuthSnapshot => this.snapshot;
  getSubject = (): AuthSubject | null => this.user ? { issuer: this.user.profile.iss, subject: this.user.profile.sub } : null;
  private publish(snapshot: AuthSnapshot): void {
    if (this.disposed) return;
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }
  private current(epoch: number): boolean { return !this.disposed && this.epoch === epoch; }
  private assertCurrent(epoch: number): void { if (!this.current(epoch)) throw new ClientError('ACCOUNT_CHANGED'); }
  private signedIn(): void {
    this.publish({ status: 'signed-in', needsLogin: this.blockedCredentials || this.user?.expired !== false,
      displayName: typeof this.user?.profile.name === 'string' ? this.user.profile.name.slice(0, 160) : undefined });
  }
  private client(epoch: number): NativeOidcProtocol {
    const settings: OidcClientSettings = {
      authority: this.config.oidcAuthority, client_id: this.config.oidcClientId,
      redirect_uri: this.config.redirectUri, post_logout_redirect_uri: this.config.logoutRedirectUri,
      response_type: 'code', response_mode: 'query', scope: 'openid profile offline_access',
      disablePKCE: false, loadUserInfo: false, requestTimeoutInSeconds: 20, staleStateAgeInSeconds: 600,
      fetchRequestCredentials: 'omit',
      stateStore: new SecureOidcStateStore(this.options.secrets, this.namespace, () => this.current(epoch)),
    };
    return this.options.protocol?.(settings) ?? new OidcClient(settings);
  }
  private validate(user: User, signIn = false): void {
    const profile = user.profile;
    const audiences = typeof profile?.aud === 'string' ? [profile.aud] : profile?.aud;
    if (!profile || profile.iss !== this.config.oidcAuthority || typeof profile.sub !== 'string' || !profile.sub || profile.sub.length > 255 ||
        !Array.isArray(audiences) || !audiences.includes(this.config.oidcClientId) ||
        (audiences.length > 1 && profile.azp !== this.config.oidcClientId) ||
        (profile.azp !== undefined && profile.azp !== this.config.oidcClientId) ||
        typeof user.access_token !== 'string' || !user.access_token || user.access_token.length > 65536 ||
        user.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(user.expires_at) ||
        (user.refresh_token !== undefined && (typeof user.refresh_token !== 'string' || user.refresh_token.length > 65536))) throw new ClientError('AUTH_FAILED');
    if (signIn && (!user.id_token || user.expired !== false || !Number.isFinite(profile.exp) ||
        profile.exp <= Math.floor(Date.now() / 1000) || !Number.isFinite(profile.iat) || profile.iat > Date.now() / 1000 + 120)) throw new ClientError('AUTH_FAILED');
  }
  private persist(user: User, epoch: number): Promise<void> {
    return serializeSecret(this.options.secrets, `${this.namespace}:session`, async () => {
      this.assertCurrent(epoch);
      await this.options.secrets.set(this.namespace, 'session', JSON.stringify({ version: 1, user: user.toStorageString(), blocked: this.blockedCredentials }));
      if (!this.current(epoch)) {
        await this.options.secrets.remove(this.namespace, 'session');
        throw new ClientError('ACCOUNT_CHANGED');
      }
    });
  }
  private clearPersisted(): Promise<void> {
    return serializeSecret(this.options.secrets, `${this.namespace}:session`, async () => {
      await this.options.secrets.remove(this.namespace, 'session');
      await this.states.clear();
    });
  }
  initialize(): Promise<void> {
    this.initialization ??= (async () => {
      const epoch = this.epoch;
      this.assertCurrent(epoch);
      const unlisten = await this.options.bridge.listen((url) => {
        void Promise.resolve().then(() => this.initialize()).then(() => this.receive(url)).catch(() => undefined);
      });
      if (this.disposed) { await unlisten(); return; }
      this.unlisten = unlisten;
      if (this.options.bridge.listenFinished) {
        const finished = await this.options.bridge.listenFinished(() => {
          if (!this.awaitingBrowser || this.disposed) return;
          this.awaitingBrowser = false;
          // Custom Tabs can finish just before an already-issued URL reaches App.
          // Enable retry while keeping its bounded PKCE state available for that callback.
          this.publish({ status: 'error', error: new ClientError('AUTH_FAILED') });
        });
        if (this.disposed) { await finished(); return; }
        this.unlistenFinished = finished;
      }
      this.assertCurrent(epoch);
      const raw = await serializeSecret(this.options.secrets, `${this.namespace}:session`, () => this.options.secrets.get(this.namespace, 'session'));
      this.assertCurrent(epoch);
      if (raw) {
        try {
          const stored = JSON.parse(raw) as { version?: number; user?: string; blocked?: boolean };
          if (stored.version !== 1 || typeof stored.user !== 'string' || typeof stored.blocked !== 'boolean') throw new Error();
          const user = User.fromStorageString(stored.user);
          this.validate(user);
          this.user = user;
          this.blockedCredentials = stored.blocked;
          this.signedIn();
        } catch {
          await this.clearPersisted();
          this.publish({ status: 'error', error: new ClientError('AUTH_REQUIRED') });
        }
      }
      const url = await this.options.bridge.launchUrl();
      this.assertCurrent(epoch);
      if (url) await this.receive(url).catch(() => undefined);
    })().catch((error) => {
      if (error instanceof ClientError && error.code === 'ACCOUNT_CHANGED') return;
      if (!this.disposed) this.publish({ status: 'error', error: new ClientError('STORAGE_UNAVAILABLE') });
      throw error instanceof ClientError ? error : new ClientError('STORAGE_UNAVAILABLE');
    });
    return this.initialization;
  }
  private receive(url: string): Promise<void> {
    let endpoint: string;
    try { const parsed = new URL(url); endpoint = `${parsed.protocol}//${parsed.host}${parsed.pathname}`; }
    catch { return Promise.resolve(); }
    if (endpoint !== this.config.redirectUri && endpoint !== this.config.logoutRedirectUri) return Promise.resolve();
    const result = this.callbackTail.then(async () => {
      if (this.disposed) return;
      const epoch = this.epoch;
      try {
        if (endpoint === this.config.redirectUri) await this.consumeSignIn(url);
        else {
          nativeCallback(url, this.config.logoutRedirectUri, true);
          await this.client(this.epoch).processSignoutResponse(url);
          await this.options.bridge.close().catch(() => undefined);
        }
      } catch (error) {
        if (!this.user && this.current(epoch)) this.publish({ status: 'error', error: new ClientError('AUTH_FAILED') });
        throw error instanceof ClientError ? error : new ClientError('AUTH_FAILED');
      }
    });
    this.callbackTail = result.catch(() => undefined);
    return result;
  }
  async signIn(): Promise<void> {
    await this.initialize();
    const epoch = ++this.epoch;
    this.assertCurrent(epoch);
    this.user = null;
    this.refresh = null;
    this.blockedCredentials = false;
    this.publish({ status: 'signing-in' });
    try {
      await this.clearPersisted();
      this.assertCurrent(epoch);
      const request = await this.client(epoch).createSigninRequest({ request_type: 'si:r', nonce: crypto.randomUUID() });
      this.assertCurrent(epoch);
      this.awaitingBrowser = true;
      await this.options.bridge.open(browserUrl(request.url));
      this.assertCurrent(epoch);
    } catch (error) {
      if (this.current(epoch)) {
        this.awaitingBrowser = false;
        await this.clearPersisted();
        this.publish({ status: 'error', error: new ClientError('AUTH_FAILED') });
      }
      throw error instanceof ClientError ? error : new ClientError('AUTH_FAILED');
    }
  }
  async completeSignIn(url: string): Promise<void> {
    nativeCallback(url, this.config.redirectUri);
    await this.initialize();
    await this.receive(url);
  }
  private async consumeSignIn(url: string): Promise<void> {
    const { state } = nativeCallback(url, this.config.redirectUri);
    if (this.completedStates.has(state)) return;
    const previousEpoch = this.epoch;
    const pending = await this.states.get(state);
    this.assertCurrent(previousEpoch);
    if (!pending) throw new ClientError('AUTH_FAILED');
    try { if (JSON.parse(pending).request_type !== 'si:r') throw new Error(); }
    catch { throw new ClientError('AUTH_FAILED'); }
    const issuer = new URL(url).searchParams.get('iss');
    if (issuer !== null && issuer !== this.config.oidcAuthority) throw new ClientError('AUTH_FAILED');
    const epoch = ++this.epoch;
    this.awaitingBrowser = false;
    this.user = null;
    this.refresh = null;
    this.publish({ status: 'signing-in' });
    try {
      const response = await this.client(epoch).processSigninResponse(url);
      this.assertCurrent(epoch);
      const user = new User(response);
      this.validate(user, true);
      this.blockedCredentials = false;
      await this.persist(user, epoch);
      this.assertCurrent(epoch);
      this.user = user;
      this.completedStates.add(state);
      if (this.completedStates.size > 8) this.completedStates.delete(this.completedStates.values().next().value!);
      this.signedIn();
      await this.options.bridge.close().catch(() => undefined);
    } catch (error) {
      if (this.current(epoch)) {
        this.user = null;
        await this.clearPersisted();
        this.publish({ status: 'error', error: new ClientError('AUTH_FAILED') });
      }
      throw error instanceof ClientError ? error : new ClientError('AUTH_FAILED');
    }
  }
  getAccessToken = async (): Promise<string> => {
    await this.initialize();
    const user = this.user;
    const epoch = this.epoch;
    this.assertCurrent(epoch);
    if (!user || this.blockedCredentials) throw new ClientError('AUTH_REQUIRED');
    if ((user.expires_in ?? 0) > 30 || (!user.refresh_token && user.expired === false)) return user.access_token;
    if (!user.refresh_token) { this.signedIn(); throw new ClientError('AUTH_REQUIRED'); }
    if (!this.refresh) {
      const attempt = this.refreshUser(user, epoch);
      this.refresh = attempt;
      void attempt.finally(() => { if (this.refresh === attempt) this.refresh = null; }).catch(() => undefined);
    }
    return this.refresh;
  };
  private async refreshUser(user: User, epoch: number): Promise<string> {
    try {
      const response = await this.client(epoch).useRefreshToken({ state: {
        refresh_token: user.refresh_token!, id_token: user.id_token, session_state: user.session_state, scope: user.scope, profile: user.profile,
      } });
      this.assertCurrent(epoch);
      const next = new User({ ...response, refresh_token: response.refresh_token ?? user.refresh_token, id_token: response.id_token ?? user.id_token });
      this.validate(next, response.id_token !== undefined);
      if (next.expired !== false || next.profile.sub !== user.profile.sub || next.profile.iss !== user.profile.iss || next.profile.sid !== user.profile.sid) throw new ClientError('AUTH_REQUIRED');
      await this.persist(next, epoch);
      this.assertCurrent(epoch);
      this.user = next;
      this.signedIn();
      return next.access_token;
    } catch (error) {
      if (this.current(epoch)) {
        const providerError = error && typeof error === 'object' && 'error' in error ? error.error : undefined;
        if (error instanceof ClientError || ['invalid_grant', 'invalid_token', 'unauthorized_client'].includes(String(providerError))) {
          this.blockedCredentials = true;
          await this.persist(user, epoch);
        }
        this.publish({ ...this.snapshot, status: 'signed-in', needsLogin: true, error: new ClientError('AUTH_REQUIRED') });
      }
      throw new ClientError('AUTH_REQUIRED');
    }
  }
  async clearLocalSession(): Promise<void> {
    const epoch = ++this.epoch;
    this.awaitingBrowser = false;
    this.user = null;
    this.refresh = null;
    this.blockedCredentials = false;
    this.publish({ status: 'signed-out' });
    await this.clearPersisted();
    if (this.current(epoch)) await this.options.bridge.close().catch(() => undefined);
  }
  async signOut(): Promise<void> {
    const idToken = this.user?.id_token;
    await this.clearLocalSession();
    const epoch = this.epoch;
    this.assertCurrent(epoch);
    try {
      const request = await this.client(epoch).createSignoutRequest({ id_token_hint: idToken, client_id: this.config.oidcClientId,
        post_logout_redirect_uri: this.config.logoutRedirectUri, request_type: 'so:r', state: crypto.randomUUID() });
      this.assertCurrent(epoch);
      await this.options.bridge.open(browserUrl(request.url));
    } catch { throw new ClientError('NETWORK_UNAVAILABLE', true); }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    ++this.epoch;
    this.user = null;
    this.awaitingBrowser = false;
    this.refresh = null;
    this.listeners.clear();
    if (this.unlisten) await this.unlisten();
    if (this.unlistenFinished) await this.unlistenFinished();
    await serializeSecret(this.options.secrets, `${this.namespace}:session`, async () => undefined);
    await serializeSecret(this.options.secrets, `${this.namespace}:state`, async () => undefined);
  }
}

export async function createNativeAuthSession(config: AppConfig): Promise<AuthSession> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('App') || !Capacitor.isPluginAvailable('Browser')) throw new ClientError('NATIVE_NOT_READY');
  const secrets = await createSecretStore();
  if (secrets.persistence !== 'system') throw new ClientError('STORAGE_UNAVAILABLE');
  return new NativeOidcSession(config, { secrets, bridge: {
    open: async (url) => { await Browser.open({ url, presentationStyle: 'popover' }); },
    close: async () => { await Browser.close(); },
    listen: async (listener) => { const handle = await App.addListener('appUrlOpen', (event) => listener(event.url)); return () => handle.remove(); },
    listenFinished: async (listener) => { const handle = await Browser.addListener('browserFinished', listener); return () => handle.remove(); },
    launchUrl: async () => (await App.getLaunchUrl())?.url,
  } });
}
