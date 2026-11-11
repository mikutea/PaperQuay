import { parseAppConfig, PUBLIC_CONFIG_STORAGE_KEY, type PublicConfigInput } from './config.ts';

/** Public connection defaults only. Credentials never belong in this document. */
export function checkedRuntimeConfig(value: unknown, origin: string): PublicConfigInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('RUNTIME_CONFIG_INVALID');
  const keys = Object.keys(value);
  if (!keys.length) return {};
  if (keys.length !== 3 || keys.some(key => !['apiBaseUrl', 'oidcAuthority', 'oidcClientId'].includes(key))
    || Object.values(value).some(item => typeof item !== 'string')) throw new Error('RUNTIME_CONFIG_INVALID');
  const parsed = parseAppConfig(value as PublicConfigInput, origin);
  return { apiBaseUrl: parsed.apiBaseUrl, oidcAuthority: parsed.oidcAuthority, oidcClientId: parsed.oidcClientId };
}

/** The optional same-origin file can be mounted by the operator after building. */
export async function loadRuntimeConfig(origin: string, fetcher: typeof fetch = fetch): Promise<PublicConfigInput> {
  let base: URL;
  try { base = new URL(origin); } catch { return {}; }
  // Native containers keep explicit connection settings. Existing/offline web
  // users open their local library without waiting for a deployment defaults file.
  if (!['https:', 'http:'].includes(base.protocol) || globalThis.navigator?.onLine === false) return {};
  let saved: string | null | undefined;
  try {
    saved = globalThis.localStorage?.getItem(PUBLIC_CONFIG_STORAGE_KEY);
    if (saved) { parseAppConfig(JSON.parse(saved), origin); return {}; }
  } catch { /* Invalid/unavailable public settings do not prevent first-run defaults. */ }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetcher(new URL('/runtime-config.json', base), {
      signal: controller.signal, cache: 'no-store', credentials: 'omit', redirect: 'error',
    });
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/json')) return {};
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) throw new Error('RUNTIME_CONFIG_INVALID');
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const defaults = checkedRuntimeConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), origin);
    if (Object.keys(defaults).length) {
      try {
        const storage = globalThis.localStorage;
        // Keep the public connection settings through login navigation without
        // replacing a connection the user selected while this file was loading.
        if (storage && storage.getItem(PUBLIC_CONFIG_STORAGE_KEY) === saved) {
          storage.setItem(PUBLIC_CONFIG_STORAGE_KEY, JSON.stringify(defaults));
        }
      } catch { /* Fetched defaults remain usable when public settings cannot be saved. */ }
    }
    return defaults;
  } catch {
    // The ordinary explicit connection form remains available on older hosts,
    // native containers, and when an operator supplied an invalid document.
    return {};
  } finally {
    clearTimeout(timer);
    await reader?.cancel().catch(() => undefined);
  }
}
