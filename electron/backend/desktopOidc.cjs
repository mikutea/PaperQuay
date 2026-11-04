const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');

const CALLBACK_PATH = '/paperquay-oidc/callback';
const LOGIN_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REFRESH_EARLY_MS = 60_000;

function authError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function checkedUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw authError('ACCOUNT_CONFIGURATION_INVALID'); }
  if (url.username || url.password || url.hash || url.search || url.href.length > 2048
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw authError('ACCOUNT_CONFIGURATION_INVALID');
  }
  return url;
}

function validateDesktopAccountConfig(value) {
  if (!value || typeof value !== 'object' || typeof value.oidcClientId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,255}$/.test(value.oidcClientId)) throw authError('ACCOUNT_CONFIGURATION_INVALID');
  return {
    apiBaseUrl: checkedUrl(value.apiBaseUrl).href.replace(/\/$/, ''),
    oidcIssuer: checkedUrl(value.oidcIssuer).href.replace(/\/$/, ''),
    oidcClientId: value.oidcClientId,
  };
}

function abortable(promise, signal) {
  const operation = Promise.resolve(promise);
  if (!signal) return operation;
  if (signal.aborted) {
    void operation.catch(() => {});
    return Promise.reject(authError('AUTH_CANCELLED'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(authError('AUTH_CANCELLED')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    operation.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}

function sameState(actual, expected) {
  if (typeof actual !== 'string') return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeDisplayName(claims) {
  const value = claims.name || claims.preferred_username;
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120) : undefined;
}

/** Tokens and authorization codes stay in this main-process closure. No persistence or renderer token API. */
function createDesktopOidcSession({ openExternal, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (typeof openExternal !== 'function') throw new TypeError('openExternal is required');
  const listeners = new Set();
  let snapshot = { status: 'signed-out' };
  let epoch = 0;
  let session;
  let signingIn;
  let refresh;
  let closed = false;
  const emit = (value) => {
    snapshot = value;
    for (const listener of listeners) { try { listener({ ...snapshot }); } catch { /* isolate subscribers */ } }
  };
  const check = (generation) => {
    if (closed || generation !== epoch) throw authError('AUTH_CANCELLED');
  };
  const clear = () => {
    epoch += 1;
    signingIn?.controller.abort();
    session?.controller.abort();
    signingIn = undefined;
    session = undefined;
    refresh = undefined;
  };

  function boundedFetch(issuer, signal) {
    const origin = new URL(issuer).origin;
    return async (input, init = {}) => {
      const target = checkedUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (target.origin !== origin) throw authError('IDENTITY_PROVIDER_CONFIGURATION_INVALID');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const combined = AbortSignal.any([controller.signal, signal, ...(init.signal ? [init.signal] : [])]);
      try {
        const response = await abortable(Promise.resolve(fetchImpl(input, { ...init, redirect: 'error', signal: combined })), combined);
        const declaredLength = response.headers.get('content-length');
        if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_RESPONSE_BYTES)) {
          void response.body?.cancel().catch(() => {});
          throw authError('IDENTITY_PROVIDER_RESPONSE_INVALID');
        }
        if (!response.body) throw authError('IDENTITY_PROVIDER_RESPONSE_INVALID');
        const reader = response.body.getReader();
        const chunks = [];
        let total = 0;
        try {
          while (true) {
            const { done, value } = await abortable(reader.read(), combined);
            if (done) break;
            total += value.byteLength;
            if (total > MAX_RESPONSE_BYTES) throw authError('IDENTITY_PROVIDER_RESPONSE_INVALID');
            chunks.push(Buffer.from(value));
          }
        } finally { void reader.cancel().catch(() => {}); }
        return new Response(Buffer.concat(chunks, total), { status: response.status, statusText: response.statusText, headers: response.headers });
      } finally { clearTimeout(timer); }
    };
  }

  function captureTokens(tokens, previous) {
    const claims = tokens.claims();
    // Refresh may omit an ID token (OIDC Core 12.2). Only the already verified
    // session can supply that identity; initial sign-in still requires claims.
    if (claims === undefined) {
      if (!previous || tokens.id_token !== undefined) throw authError('AUTH_RESPONSE_INVALID');
    } else if (!claims || typeof claims.sub !== 'string' || !claims.sub || typeof claims.iss !== 'string'
        || (claims.sid !== undefined && typeof claims.sid !== 'string')) {
      throw authError('AUTH_RESPONSE_INVALID');
    }
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 131072
        || typeof tokens.expires_in !== 'number' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0
        || !Number.isSafeInteger(Math.ceil(Date.now() + tokens.expires_in * 1000))
        || (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length > 131072))) {
      throw authError('AUTH_RESPONSE_INVALID');
    }
    if (claims && previous && (claims.sub !== previous.subject || claims.iss !== previous.issuer || claims.sid !== previous.sid)) {
      throw authError('AUTH_SESSION_CHANGED');
    }
    return {
      accessToken: tokens.access_token, refreshToken: tokens.refresh_token || previous?.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      issuer: claims ? claims.iss : previous.issuer, subject: claims ? claims.sub : previous.subject,
      sid: claims ? claims.sid : previous.sid, displayName: claims ? safeDisplayName(claims) || previous?.displayName : previous.displayName,
    };
  }

  async function signIn(rawConfig, signal) {
    if (closed) throw authError('AUTH_CLOSED');
    const config = validateDesktopAccountConfig(rawConfig);
    clear();
    const generation = epoch;
    const controller = new AbortController();
    const task = { controller };
    signingIn = task;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timer = setTimeout(abort, LOGIN_TIMEOUT_MS);
    let server;
    emit({ status: 'signing-in' });
    try {
      const oidc = await abortable(import('openid-client'), controller.signal);
      const issuer = new URL(config.oidcIssuer);
      const oauth = await oidc.discovery(issuer, config.oidcClientId, { token_endpoint_auth_method: 'none' }, oidc.None(), {
        timeout: REQUEST_TIMEOUT_MS / 1000,
        [oidc.customFetch]: boundedFetch(config.oidcIssuer, controller.signal),
        execute: [oidc.enableNonRepudiationChecks, ...(issuer.protocol === 'http:' ? [oidc.allowInsecureRequests] : [])],
      });
      check(generation);
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        const endpoint = checkedUrl(oauth.serverMetadata()[key]);
        if (endpoint.origin !== issuer.origin) throw authError('IDENTITY_PROVIDER_CONFIGURATION_INVALID');
      }
      const verifier = oidc.randomPKCECodeVerifier();
      const challenge = await oidc.calculatePKCECodeChallenge(verifier);
      const nonce = oidc.randomNonce();
      const state = oidc.randomState();
      let accepted = false;
      let acceptCallback;
      const callback = new Promise((resolve) => { acceptCallback = resolve; });
      server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'text/plain; charset=utf-8');
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        response.setHeader('Referrer-Policy', 'no-referrer');
        const port = server.address()?.port;
        const host = `127.0.0.1:${port}`;
        if (request.method !== 'GET' || request.headers.host !== host || !request.url || request.url.length > 8192) {
          response.writeHead(400).end('Invalid sign-in response.'); return;
        }
        let url;
        try {
          if (!request.url.startsWith('/') || request.url.startsWith('//')) throw new Error('Invalid request target');
          url = new URL(request.url, `http://${host}`);
        } catch { response.writeHead(400).end('Invalid sign-in response.'); return; }
        if (url.origin !== `http://${host}` || url.pathname !== CALLBACK_PATH || accepted
            || url.searchParams.getAll('state').length !== 1 || !sameState(url.searchParams.get('state'), state)) {
          response.writeHead(400).end('Invalid sign-in response.'); return;
        }
        accepted = true;
        acceptCallback({ url, response });
      });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.maxConnections = 8;
      await abortable(new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      }), controller.signal);
      check(generation);
      const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
      const authorizationUrl = oidc.buildAuthorizationUrl(oauth, {
        redirect_uri: redirectUri, scope: 'openid profile', response_type: 'code',
        code_challenge: challenge, code_challenge_method: 'S256', nonce, state,
      });
      await abortable(Promise.resolve(openExternal(authorizationUrl.href)), controller.signal);
      const received = await abortable(callback, controller.signal);
      try {
        const tokens = await oidc.authorizationCodeGrant(oauth, received.url, {
          pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
        });
        check(generation);
        const values = captureTokens(tokens);
        session = { ...values, oauth, oidc, controller };
        emit({ status: 'signed-in', displayName: values.displayName, expiresAt: values.expiresAt });
        received.response.end('PaperQuay sign-in completed. You can return to the app.\nPaperQuay 登录完成，可以返回应用。');
      } catch (error) {
        received.response.writeHead(400).end('PaperQuay sign-in failed. Return to the app to try again.');
        throw error;
      }
    } catch (error) {
      if (generation === epoch && !closed) {
        controller.abort();
        session = undefined;
        emit({ status: controller.signal.aborted && error?.code === 'AUTH_CANCELLED' ? 'signed-out' : 'error',
          errorCode: error?.code === 'AUTH_SESSION_CHANGED' ? 'AUTH_SESSION_CHANGED' : 'AUTH_SIGN_IN_FAILED' });
      }
      throw authError(error?.code === 'AUTH_CANCELLED' ? 'AUTH_CANCELLED' : 'AUTH_SIGN_IN_FAILED');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      // End the loopback listener and any half-open callback sockets on every path.
      server?.close();
      server?.closeAllConnections();
      if (signingIn === task) signingIn = undefined;
    }
  }

  async function getAccessToken(signal) {
    if (!session || closed) throw authError('AUTHENTICATION_REQUIRED');
    const generation = epoch;
    const current = session;
    if (current.expiresAt - Date.now() <= REFRESH_EARLY_MS) {
      if (!refresh) {
        refresh = (async () => {
          try {
            if (!current.refreshToken) throw authError('AUTHENTICATION_REQUIRED');
            const tokens = await current.oidc.refreshTokenGrant(current.oauth, current.refreshToken);
            check(generation);
            const values = captureTokens(tokens, current);
            session = { ...current, ...values };
            emit({ status: 'signed-in', displayName: values.displayName, expiresAt: values.expiresAt });
          } catch (error) {
            if (generation === epoch) {
              clear();
              emit({ status: 'error', errorCode: error?.code === 'AUTH_SESSION_CHANGED' ? 'AUTH_SESSION_CHANGED' : 'AUTHENTICATION_REQUIRED' });
            }
            throw authError('AUTHENTICATION_REQUIRED');
          } finally { if (generation === epoch) refresh = undefined; }
        })();
      }
      await abortable(refresh, signal);
    }
    check(generation);
    if (signal?.aborted) throw authError('AUTH_CANCELLED');
    return session.accessToken;
  }

  return {
    getSnapshot: () => ({ ...snapshot }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    signIn, getAccessToken,
    cancelSignIn() { if (signingIn) { clear(); emit({ status: 'signed-out' }); } },
    async signOut() { clear(); emit({ status: 'signed-out' }); },
    close() { clear(); closed = true; emit({ status: 'signed-out' }); listeners.clear(); },
  };
}

module.exports = { createDesktopOidcSession, validateDesktopAccountConfig };
