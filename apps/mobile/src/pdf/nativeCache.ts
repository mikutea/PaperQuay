import { accountScopeKey, type AccountScope } from '../storage/accountStore.ts';
import { sha256 } from './acquisition.ts';
import { PdfError, throwIfAborted } from './errors.ts';
import type { PdfCache, PdfCacheEntry, PdfVersion } from './types.ts';
import {
  assertVersionBytes, cacheKey, decodeCacheRecord, defaultCacheLimits, newCacheRecord, planCacheWrite,
  type CacheLimits, type CacheRecord,
} from './cachePolicy.ts';

export type CacheArea = 'cache' | 'data';
/** A narrow app-private filesystem port. No user path or external-storage operation is accepted. */
export interface NativePdfFiles {
  readManifest(slot: 'a' | 'b'): Promise<string | null>;
  writeManifest(slot: 'a' | 'b', value: string): Promise<void>;
  list(area: CacheArea): Promise<string[]>;
  read(area: CacheArea, name: string, size: number): Promise<Uint8Array | null>;
  write(area: CacheArea, name: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  remove(area: CacheArea, name: string): Promise<void>;
}
interface NativeRecord extends CacheRecord { area: CacheArea; name: string }
interface Manifest { formatVersion: 1; generation: number; records: NativeRecord[] }
interface Loaded { current: Manifest; slots: { a: Manifest | null; b: Manifest | null } }
const ownedName = /^[0-9a-f]{64}\.[0-9a-f-]{36}\.[0-9a-f-]{36}\.pdf$/;
const encoder = new TextEncoder();
let nativeQueue: Promise<unknown> = Promise.resolve();

async function unpack(value: string | null): Promise<Manifest | null> {
  if (value === null) return null;
  try {
    if (value.length > 4 * 1024 * 1024) return null;
    const wrapper = JSON.parse(value) as { payload: Manifest; sha256: string };
    const data = wrapper.payload;
    if (!data || data.formatVersion !== 1 || !Number.isSafeInteger(data.generation) || data.generation < 0
      || !Array.isArray(data.records) || data.records.length > defaultCacheLimits.maxCacheEntries
      || await sha256(encoder.encode(JSON.stringify(data))) !== wrapper.sha256) return null;
    const keys = new Set<string>();
    for (const record of data.records) {
      decodeCacheRecord(record);
      if (!ownedName.test(record.name) || (record.area !== 'cache' && record.area !== 'data')
        || record.entry.pinned !== (record.area === 'data') || keys.has(record.key)
        || !record.name.startsWith(`${await sha256(encoder.encode(record.scopeKey))}.${record.entry.versionId}.`)) return null;
      keys.add(record.key);
    }
    return data;
  } catch { return null; }
}

/** Two checksummed manifests preserve the previous complete generation across an interrupted write. */
export class NativePdfCache implements PdfCache {
  private readonly files: NativePdfFiles;
  private readonly limits: CacheLimits;
  private readonly now: () => number;
  private readonly makeId: () => string;

  constructor(files: NativePdfFiles, options: { limits?: Partial<CacheLimits>; now?: () => number; makeId?: () => string } = {}) {
    this.files = files;
    this.limits = { ...defaultCacheLimits, ...options.limits };
    this.now = options.now ?? Date.now;
    this.makeId = options.makeId ?? (() => crypto.randomUUID());
  }

  private serialized<T>(action: () => Promise<T>): Promise<T> {
    const work = nativeQueue.then(action, action).catch((error) => {
      throw error instanceof PdfError ? error : new PdfError('CACHE_UNAVAILABLE');
    });
    nativeQueue = work.catch(() => undefined);
    return work;
  }

  private async load(): Promise<Loaded> {
    const [rawA, rawB] = await Promise.all([this.files.readManifest('a'), this.files.readManifest('b')]);
    const [a, b] = await Promise.all([unpack(rawA), unpack(rawB)]);
    if (!a && !b) {
      if (rawA !== null || rawB !== null) throw new PdfError('CACHE_CORRUPT');
      const existing = (await Promise.all([this.files.list('cache'), this.files.list('data')])).flat();
      if (existing.some((name) => ownedName.test(name))) throw new PdfError('CACHE_CORRUPT');
      const empty: Manifest = { formatVersion: 1, generation: 0, records: [] };
      const initial: Loaded = { current: empty, slots: { a: null, b: null } };
      await this.commit(initial, []);
      return initial;
    }
    const loaded: Loaded = { current: !b || (a && a.generation >= b.generation) ? a! : b,
      slots: { a, b } };
    await this.cleanup(loaded);
    return loaded;
  }

  private async writeSlot(slot: 'a' | 'b', manifest: Manifest): Promise<void> {
    const value = JSON.stringify({ payload: manifest, sha256: await sha256(encoder.encode(JSON.stringify(manifest))) });
    await this.files.writeManifest(slot, value);
    const verified = await unpack(await this.files.readManifest(slot));
    if (!verified || JSON.stringify(verified) !== JSON.stringify(manifest)) throw new PdfError('CACHE_UNAVAILABLE');
  }

  private async commit(loaded: Loaded, records: NativeRecord[]): Promise<boolean> {
    const next: Manifest = { formatVersion: 1, generation: loaded.current.generation + 1, records };
    if (!Number.isSafeInteger(next.generation)) throw new PdfError('CACHE_UNAVAILABLE');
    const first = (loaded.slots.a?.generation ?? -1) <= (loaded.slots.b?.generation ?? -1) ? 'a' : 'b';
    const second = first === 'a' ? 'b' : 'a';
    await this.writeSlot(first, next);
    loaded.slots[first] = next;
    loaded.current = next;
    let mirrored = false;
    try { await this.writeSlot(second, next); loaded.slots[second] = next; mirrored = true; }
    catch { /* The verified first slot is durable; retain the older generation's files. */ }
    await this.cleanup(loaded);
    return mirrored;
  }

  private async cleanup(loaded: Loaded): Promise<void> {
    // Retain files referenced by either recoverable generation, including older pinned bytes.
    const keep = new Set([loaded.slots.a, loaded.slots.b].flatMap((slot) =>
      slot?.records.map((record) => `${record.area}:${record.name}`) ?? []));
    for (const area of ['cache', 'data'] as const) {
      for (const name of await this.files.list(area)) {
        if (ownedName.test(name) && !keep.has(`${area}:${name}`)) await this.files.remove(area, name);
      }
    }
  }

  async list(scope: AccountScope): Promise<PdfCacheEntry[]> {
    return this.serialized(async () => {
      const loaded = await this.load();
      return loaded.current.records.filter((record) => record.scopeKey === accountScopeKey(scope))
        .map((record) => ({ ...record.entry })).sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    });
  }

  async read(scope: AccountScope, version: PdfVersion): Promise<Uint8Array | null> {
    return this.serialized(async () => {
      const loaded = await this.load();
      const record = loaded.current.records.find((item) => item.key === cacheKey(scope, version.entityId));
      if (!record) return null;
      const bytes = await this.files.read(record.area, record.name, record.entry.sizeBytes);
      if (!bytes) {
        await this.commit(loaded, loaded.current.records.filter((item) => item !== record));
        return null;
      }
      try { await assertVersionBytes(version, bytes); }
      catch { throw new PdfError('CACHE_CORRUPT'); }
      await this.commit(loaded, loaded.current.records.map((item) => item === record
        ? { ...item, entry: { ...item.entry, lastUsedAt: this.now() } } : item));
      return bytes;
    });
  }

  async put(scope: AccountScope, version: PdfVersion, bytes: Uint8Array,
    options: { pinned?: boolean; sourceUrl?: string; signal?: AbortSignal } = {}): Promise<void> {
    throwIfAborted(options.signal);
    await assertVersionBytes(version, bytes);
    return this.serialized(async () => {
      throwIfAborted(options.signal);
      const loaded = await this.load();
      const old = loaded.current.records.find((item) => item.key === cacheKey(scope, version.entityId));
      const metadata = newCacheRecord(scope, version, this.now(), old, options);
      const area = metadata.entry.pinned ? 'data' : 'cache';
      const name = `${await sha256(encoder.encode(metadata.scopeKey))}.${version.entityId}.${this.makeId()}.pdf`;
      if (!ownedName.test(name)) throw new PdfError('CACHE_UNAVAILABLE');
      const record: NativeRecord = { ...metadata, area, name };
      const plan = planCacheWrite(loaded.current.records, record, this.limits);
      let committed = false;
      let manifestAttempted = false;
      try {
        await this.files.write(area, name, bytes, options.signal);
        throwIfAborted(options.signal);
        manifestAttempted = true;
        await this.commit(loaded, plan.records);
        committed = true;
      } finally {
        // A failed first manifest write must keep the old visible cache intact.
        // An uncertain manifest write may already be durable. The next load verifies both
        // generations before reclaiming an unreferenced file, never a committed new copy.
        if (!committed && !manifestAttempted) {
          await this.files.remove(area, name).catch(() => undefined);
        }
      }
    });
  }

  async setPinned(scope: AccountScope, versionId: string, pinned: boolean): Promise<void> {
    return this.serialized(async () => {
      const loaded = await this.load();
      const old = loaded.current.records.find((item) => item.key === cacheKey(scope, versionId));
      if (!old) throw new PdfError('CACHE_MISSING');
      if (old.entry.pinned === pinned) return;
      const bytes = await this.files.read(old.area, old.name, old.entry.sizeBytes);
      if (!bytes || await sha256(bytes) !== old.entry.sha256) throw new PdfError('CACHE_CORRUPT');
      const record: NativeRecord = { ...old, area: pinned ? 'data' : 'cache',
        name: `${await sha256(encoder.encode(old.scopeKey))}.${versionId}.${this.makeId()}.pdf`,
        entry: { ...old.entry, pinned, lastUsedAt: this.now() } };
      const plan = planCacheWrite(loaded.current.records, record, this.limits);
      let manifestAttempted = false;
      try {
        await this.files.write(record.area, record.name, bytes);
        manifestAttempted = true;
        await this.commit(loaded, plan.records);
      } catch (error) {
        if (!manifestAttempted) {
          await this.files.remove(record.area, record.name).catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async remove(scope: AccountScope, versionId: string): Promise<void> {
    return this.serialized(async () => {
      const loaded = await this.load();
      const mirrored = await this.commit(loaded, loaded.current.records.filter((item) => item.key !== cacheKey(scope, versionId)));
      if (!mirrored) throw new PdfError('CACHE_UNAVAILABLE');
    });
  }

  async clear(scope: AccountScope, options: { includePinned?: boolean } = {}): Promise<void> {
    return this.serialized(async () => {
      const loaded = await this.load();
      const mirrored = await this.commit(loaded, loaded.current.records.filter((item) =>
        item.scopeKey !== accountScopeKey(scope) || (!options.includePinned && item.entry.pinned)));
      if (!mirrored) throw new PdfError('CACHE_UNAVAILABLE');
    });
  }

  async close(): Promise<void> { await nativeQueue; }
}
