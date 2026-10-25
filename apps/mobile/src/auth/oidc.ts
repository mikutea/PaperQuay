import {
  InMemoryWebStorage,
  Log,
  UserManager,
  WebStorageStateStore,
  type User,
  type UserManagerSettings,
} from 'oidc-client-ts';
import type { AppConfig } from '../config.ts';
import { ClientError } from '../errors.ts';

export interface AuthSnapshot {
  status: 'signed-out' | 'signing-in' | 'signed-in' | 'error';
  displayName?: string;
  error?: ClientError;
}

export function buildOidcSettings(
  config: AppConfig,
  transientStorage: Storage,
): UserManagerSettings {
  return {
    authority: config.oidcAuthority,
    client_id: config.oidcClientId,
    redirect_uri: config.redirectUri,
    post_logout_redirect_uri: config.logoutRedirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: 'openid profile',
    disablePKCE: false,
    loadUserInfo: false,
    automaticSilentRenew: false,
    monitorSession: false,
    requestTimeoutInSeconds: 20,
    staleStateAgeInSeconds: 10 * 60,
    userStore: new WebStorageStateStore({
      store: new InMemoryWebStorage(),
      prefix: 'paperquay.auth.user.',
    }),
    stateStore: new WebStorageStateStore({
      store: transientStorage,
      prefix: 'paperquay.auth.state.',
    }),
  };
}

/** Web-only in M1. Tokens are never exposed through reactive snapshots or durable storage. */
export class OidcSession {
  private readonly manager: UserManager;
  private readonly config: AppConfig;
  private user: User | null = null;
  private snapshot: AuthSnapshot = { status: 'signed-out' };
  private listeners = new Set<() => void>();
  private refresh: Promise<User | null> | null = null;
  private epoch = 0;

  constructor(config: AppConfig, transientStorage: Storage) {
    Log.setLevel(Log.NONE);
    this.config = config;
    this.manager = new UserManager(buildOidcSettings(config, transientStorage));
    this.manager.events.addAccessTokenExpired(() => {
      if (this.user && !this.user.refresh_token)
        this.setSnapshot({ status: 'error', error: new ClientError('AUTH_REQUIRED') });
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = (): AuthSnapshot => this.snapshot;

  private setSnapshot(next: AuthSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  async signIn(): Promise<void> {
    this.epoch += 1;
    this.user = null;
    this.setSnapshot({ status: 'signing-in' });
    try {
      await this.manager.removeUser();
      await this.manager.clearStaleState();
      await this.manager.signinRedirect();
    } catch {
      const error = new ClientError('AUTH_FAILED');
      this.setSnapshot({ status: 'error', error });
      throw error;
    }
  }

  async completeSignIn(url: string): Promise<void> {
    const callback = new URL(url);
    if (`${callback.origin}${callback.pathname}` !== this.config.redirectUri)
      throw new ClientError('AUTH_FAILED');
    const epoch = ++this.epoch;
    this.setSnapshot({ status: 'signing-in' });
    try {
      const user = await this.manager.signinRedirectCallback(url);
      if (epoch !== this.epoch) throw new ClientError('ACCOUNT_CHANGED');
      if (!user.access_token || !user.profile.sub || user.expired)
        throw new ClientError('AUTH_FAILED');
      this.user = user;
      this.setSnapshot({
        status: 'signed-in',
        displayName:
          typeof user.profile.name === 'string' ? user.profile.name.slice(0, 160) : undefined,
      });
    } catch {
      if (epoch === this.epoch) {
        this.user = null;
        await this.manager.removeUser();
        this.setSnapshot({ status: 'error', error: new ClientError('AUTH_FAILED') });
      }
      throw new ClientError('AUTH_FAILED');
    }
  }

  getAccessToken = async (): Promise<string> => {
    const user = this.user;
    const epoch = this.epoch;
    if (!user) throw new ClientError('AUTH_REQUIRED');
    if ((user.expires_in ?? 0) > 30) return user.access_token;
    if (!user.refresh_token) {
      if (!user.expired) return user.access_token;
      this.setSnapshot({ status: 'error', error: new ClientError('AUTH_REQUIRED') });
      throw new ClientError('AUTH_REQUIRED');
    }
    try {
      this.refresh ??= this.manager.signinSilent().finally(() => {
        this.refresh = null;
      });
      const next = await this.refresh;
      if (epoch !== this.epoch) throw new ClientError('ACCOUNT_CHANGED');
      if (
        !next ||
        next.expired ||
        next.profile.sub !== user.profile.sub ||
        next.profile.sid !== user.profile.sid
      ) {
        throw new ClientError('AUTH_REQUIRED');
      }
      this.user = next;
      return next.access_token;
    } catch {
      if (epoch === this.epoch)
        this.setSnapshot({ status: 'error', error: new ClientError('AUTH_REQUIRED') });
      throw new ClientError('AUTH_REQUIRED');
    }
  };

  async signOut(): Promise<void> {
    const idToken = this.user?.id_token;
    this.epoch += 1;
    this.user = null;
    this.setSnapshot({ status: 'signed-out' });
    await this.manager.removeUser();
    try {
      await this.manager.signoutRedirect({ id_token_hint: idToken });
    } catch {
      // Local logout is already complete, but provider logout was not confirmed.
      throw new ClientError('NETWORK_UNAVAILABLE', true);
    }
  }

  async clearLocalSession(): Promise<void> {
    this.epoch += 1;
    this.user = null;
    this.setSnapshot({ status: 'signed-out' });
    await this.manager.removeUser();
  }
}
