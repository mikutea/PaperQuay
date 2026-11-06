import { Capacitor, registerPlugin } from '@capacitor/core';

export const INCOMING_SHARE_LIMITS = Object.freeze({ items: 4, textBytes: 64 * 1024, fileBytes: 4 * 1024 * 1024, totalBytes: 8 * 1024 * 1024 });
export type IncomingShareNotice = 'FULL' | 'UNSUPPORTED' | 'TOO_LARGE' | 'INVALID' | 'READ_FAILED' | 'STORAGE_UNAVAILABLE';
export type IncomingShareMediaType = 'text/plain' | 'application/json' | 'text/markdown' | 'application/x-bibtex' | 'application/x-research-info-systems';
export interface IncomingShareMeta {
  version: 1; id: string; name: string; kind: 'text' | 'file'; mediaType: IncomingShareMediaType; sizeBytes: number; createdAt: number;
}
export interface IncomingShareItem extends IncomingShareMeta { text: string }
export interface IncomingShareList { items: IncomingShareMeta[]; notice: IncomingShareNotice | null }
export interface IncomingShareOptions { signal?: AbortSignal; current?: () => boolean }
export interface IncomingShareSubscription { remove(): Promise<void> }
/** Plugin responses are untrusted until the client has checked their closed schema. */
export interface IncomingShareDriver {
  list(options: { owner: string }): Promise<unknown>;
  read(options: { id: string; owner: string }): Promise<unknown>;
  remove(options: { id: string; owner: string }): Promise<void>;
  clear(options: { owner: string }): Promise<void>;
  purgeOwned?(options: { owner: string }): Promise<void>;
  addListener(event: 'changed', callback: () => void): Promise<IncomingShareSubscription>;
}
export interface IncomingShareClient {
  readonly available: boolean;
  list(options?: IncomingShareOptions): Promise<IncomingShareList>;
  read(meta: IncomingShareMeta, options?: IncomingShareOptions): Promise<IncomingShareItem>;
  remove(id: string, options?: IncomingShareOptions): Promise<void>;
  clear(options?: IncomingShareOptions): Promise<void>;
  purgeOwned(options?: IncomingShareOptions): Promise<void>;
  subscribe(changed: () => void, options?: IncomingShareOptions): Promise<IncomingShareSubscription>;
}
export class IncomingShareError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'INVALID' | 'TOO_LARGE' | 'READ_FAILED' | 'REMOVE_FAILED' | 'CLEAR_FAILED' | 'CHANGED' | 'CRYPTO_UNAVAILABLE') {
    super(code); this.name = 'IncomingShareError';
  }
}
const fail = (code: IncomingShareError['code']): never => { throw new IncomingShareError(code); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const notices: readonly string[] = ['FULL', 'UNSUPPORTED', 'TOO_LARGE', 'INVALID', 'READ_FAILED', 'STORAGE_UNAVAILABLE'];
const mediaTypes: readonly string[] = ['text/plain', 'application/json', 'text/markdown', 'application/x-bibtex', 'application/x-research-info-systems'];
const fields = ['version', 'id', 'name', 'kind', 'mediaType', 'sizeBytes', 'createdAt'];
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail('INVALID');
  const descriptors = Object.getOwnPropertyDescriptors(value), own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key)
    || !descriptors[key].enumerable || !('value' in descriptors[key]))) return fail('INVALID');
  return value as Record<string, unknown>;
}
export function assertIncomingShareCurrent(options: IncomingShareOptions = {}): void {
  let current = false;
  try { current = !options.signal?.aborted && (options.current?.() ?? true); } catch { /* fixed failure below */ }
  if (!current) fail('CHANGED');
}
/** Count UTF-8 only after rejecting isolated surrogates. Ordinary text is not
 * interpreted as a path, HTML, URL, or an instruction to open a resource. */
function textBytes(value: unknown): number {
  if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
    || /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(value)) return fail('INVALID');
  return new TextEncoder().encode(value).byteLength;
}
export function validateIncomingShareMeta(value: unknown): IncomingShareMeta {
  const raw = closed(value, fields);
  if (raw.version !== 1 || typeof raw.id !== 'string' || !uuid.test(raw.id) || typeof raw.name !== 'string'
    || raw.name.length < 1 || raw.name.length > 128 || raw.name.trim() !== raw.name || raw.name === '.' || raw.name === '..'
    || /[\\/:\u0000-\u001f\u007f]/u.test(raw.name) || textBytes(raw.name) < 1
    || raw.kind !== 'text' && raw.kind !== 'file' || typeof raw.mediaType !== 'string' || !mediaTypes.includes(raw.mediaType)
    || !Number.isSafeInteger(raw.sizeBytes) || (raw.sizeBytes as number) < 1
    || !Number.isSafeInteger(raw.createdAt) || (raw.createdAt as number) < 1 || (raw.createdAt as number) > 8_640_000_000_000_000) return fail('INVALID');
  const maximum = raw.kind === 'text' ? INCOMING_SHARE_LIMITS.textBytes : INCOMING_SHARE_LIMITS.fileBytes;
  if ((raw.sizeBytes as number) > maximum) return fail('TOO_LARGE');
  return { version: 1, id: raw.id, name: raw.name, kind: raw.kind, mediaType: raw.mediaType as IncomingShareMediaType,
    sizeBytes: raw.sizeBytes as number, createdAt: raw.createdAt as number };
}
export function validateIncomingShareItem(value: unknown): IncomingShareItem {
  const raw = closed(value, [...fields, 'text']), maximum = raw.kind === 'text' ? INCOMING_SHARE_LIMITS.textBytes : INCOMING_SHARE_LIMITS.fileBytes;
  if (typeof raw.text !== 'string') return fail('INVALID');
  if (raw.text.length > maximum) return fail('TOO_LARGE');
  const meta = validateIncomingShareMeta(Object.fromEntries(fields.map(field => [field, raw[field]])));
  const length = textBytes(raw.text);
  if (length > maximum) return fail('TOO_LARGE');
  if (length !== meta.sizeBytes) return fail('INVALID');
  return { ...meta, text: raw.text };
}
export function validateIncomingShareList(value: unknown): IncomingShareList {
  const raw = closed(value, ['items', 'notice']);
  if (raw.notice !== null && (typeof raw.notice !== 'string' || !notices.includes(raw.notice)) || !Array.isArray(raw.items)) return fail('INVALID');
  if (raw.items.length > INCOMING_SHARE_LIMITS.items) return fail('TOO_LARGE');
  const array = raw.items, own = Reflect.ownKeys(array);
  if (Object.getPrototypeOf(array) !== Array.prototype || own.length !== array.length + 1 || own.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)
    || Number(key) >= array.length || !Object.getOwnPropertyDescriptor(array, key)?.enumerable || !('value' in Object.getOwnPropertyDescriptor(array, key)!)))) return fail('INVALID');
  const items = array.map(validateIncomingShareMeta);
  if (new Set(items.map(item => item.id)).size !== items.length) return fail('INVALID');
  if (items.reduce((sum, item) => sum + item.sizeBytes, 0) > INCOMING_SHARE_LIMITS.totalBytes) return fail('TOO_LARGE');
  return { items, notice: raw.notice as IncomingShareNotice | null };
}

const clientOwners = new WeakMap<object, string>();
// Closed owners are fenced across retained clients for this process lifetime.
// Refuse an implausible number rather than forgetting a previously sealed owner.
const sealedOwners = new Set<string>();
/** A retained test/runtime client for account A must not be injected into B's sheet. */
export function incomingShareClientMatchesOwner(client: IncomingShareClient, ownerKey: string): boolean {
  return typeof ownerKey === 'string' && ownerKey.length > 0 && clientOwners.get(client) === ownerKey;
}
export function createIncomingShareClient(driver: IncomingShareDriver, available = true, ownerKey = ''): IncomingShareClient {
  const check = (options?: IncomingShareOptions, erasing=false) => {
    assertIncomingShareCurrent(options); if (!available) fail('UNAVAILABLE');
    if (!erasing && sealedOwners.has(ownerKey)) fail('CHANGED');
  };
  let ownerPromise: Promise<string> | undefined;
  const owner = async (options?: IncomingShareOptions, erasing=false): Promise<string> => {
    check(options, erasing);
    if (typeof ownerKey !== 'string' || !ownerKey || ownerKey.trim() !== ownerKey || ownerKey.length > 4096
      || /[\u0000-\u001f\u007f]/u.test(ownerKey)) return fail('INVALID');
    textBytes(ownerKey);
    const pending = ownerPromise ??= (async () => {
      try {
        const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(ownerKey));
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== 32) return fail('CRYPTO_UNAVAILABLE');
        return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      } catch { return fail('CRYPTO_UNAVAILABLE'); }
    })();
    let digest: string;
    try { digest = await pending; } catch {
      if (ownerPromise === pending) ownerPromise = undefined;
      check(options, erasing); return fail('CRYPTO_UNAVAILABLE');
    }
    check(options, erasing); return digest;
  };
  const invoke = async <T>(operation: () => Promise<T>, code: IncomingShareError['code'], options?: IncomingShareOptions) => {
    check(options);
    let result: T;
    try { result = await operation(); } catch { check(options); return fail(code); }
    check(options); return result;
  };
  const id = (value: string) => { if (typeof value !== 'string' || !uuid.test(value)) fail('INVALID'); return value; };
  const client: IncomingShareClient = {
    available,
    async list(options) { const boundOwner = await owner(options); return validateIncomingShareList(await invoke(() => driver.list({ owner: boundOwner }), 'READ_FAILED', options)); },
    async read(meta, options) {
      check(options); const expected = validateIncomingShareMeta(meta);
      const boundOwner = await owner(options);
      const item = validateIncomingShareItem(await invoke(() => driver.read({ id: expected.id, owner: boundOwner }), 'READ_FAILED', options));
      const actual = validateIncomingShareMeta(Object.fromEntries(fields.map(field => [field, item[field as keyof IncomingShareMeta]])));
      if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('CHANGED');
      return item;
    },
    async remove(value, options) { check(options); const selected = id(value), boundOwner = await owner(options); await invoke(() => driver.remove({ id: selected, owner: boundOwner }), 'REMOVE_FAILED', options); },
    async clear(options) { const boundOwner = await owner(options); await invoke(() => driver.clear({ owner: boundOwner }), 'CLEAR_FAILED', options); },
    async purgeOwned(options) {
      const boundOwner=await owner(options,true);check(options,true);
      if(!sealedOwners.has(ownerKey)&&sealedOwners.size>=128)fail('CLEAR_FAILED');
      sealedOwners.add(ownerKey);
      try {
        const purge=driver.purgeOwned;
        if(typeof purge!=='function')throw new IncomingShareError('CLEAR_FAILED');
        // Native operations serialize read/claim and this atomic owner-only
        // purge. New/late JS reads are fenced without touching unassigned items.
        await purge.call(driver,{owner:boundOwner});
      } catch {check(options,true);fail('CLEAR_FAILED');}
      check(options,true);
    },
    async subscribe(changed, options) {
      await owner(options); check(options);
      let subscription: IncomingShareSubscription;
      try { subscription = await driver.addListener('changed', () => {
        try { check(options); changed(); } catch { /* Retired callbacks and driver payloads never become content. */ }
      }); } catch { check(options); return fail('UNAVAILABLE'); }
      try { check(options); } catch (error) { try { await subscription.remove(); } catch { /* cleanup only */ } throw error; }
      return { async remove() { try { await subscription.remove(); } catch { /* cleanup only */ } } };
    },
  };
  clientOwners.set(client, ownerKey); return client;
}
let singleton: { ownerKey: string; client: IncomingShareClient } | undefined;
export function getIncomingShareClient(ownerKey: string): IncomingShareClient {
  if (!singleton || singleton.ownerKey !== ownerKey) singleton = { ownerKey, client: createIncomingShareClient(registerPlugin<IncomingShareDriver>('PaperQuayIncomingShare'),
    Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('PaperQuayIncomingShare'), ownerKey) };
  return singleton.client;
}
export async function purgeIncomingShareOwner(ownerKey:string,options:IncomingShareOptions={}) {
  assertIncomingShareCurrent(options);
  if(!Capacitor.isNativePlatform())return;
  await getIncomingShareClient(ownerKey).purgeOwned(options);
}
