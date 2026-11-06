import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { AccountScope } from '../storage/accountStore.ts';
import type { PdfCache } from './types.ts';
import { NativePdfCache, type CacheArea, type NativePdfFiles } from './nativeCache.ts';
import { WebPdfCache } from './webCache.ts';
import { PdfError, throwIfAborted } from './errors.ts';
import { cancelPdfTasks } from './tasks.ts';

const root = 'paperquay-pdf-v1';
const chunkSize = 256 * 1024;
const directory = (area: CacheArea) => area === 'data' ? Directory.Data : Directory.Cache;
const missing = (error: unknown) => typeof error === 'object' && error !== null
  && 'code' in error && error.code === 'OS-PLUG-FILE-0008';
function binary(bytes: Uint8Array): string {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) value += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(value);
}
function unbinary(value: string): Uint8Array {
  const raw = atob(value);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

/** All native paths originate from this module and remain under app-private Cache/Data. */
export function capacitorPdfFiles(): NativePdfFiles {
  return {
    async readManifest(slot) {
      try {
        const value = await Filesystem.readFile({ path: `${root}/manifest-${slot}.json`, directory: Directory.Data, encoding: Encoding.UTF8 });
        if (typeof value.data !== 'string') throw new PdfError('CACHE_CORRUPT');
        return value.data;
      } catch (error) { if (missing(error)) return null; throw new PdfError('CACHE_UNAVAILABLE'); }
    },
    async writeManifest(slot, value) {
      await Filesystem.writeFile({ path: `${root}/manifest-${slot}.json`, directory: Directory.Data,
        encoding: Encoding.UTF8, data: value, recursive: true });
    },
    async list(area) {
      try { return (await Filesystem.readdir({ path: root, directory: directory(area) })).files
        .filter((file) => file.type === 'file').map((file) => file.name); }
      catch (error) { if (missing(error)) return []; throw new PdfError('CACHE_UNAVAILABLE'); }
    },
    async read(area, name, size) {
      const path = `${root}/${name}`;
      try {
        const stat = await Filesystem.stat({ path, directory: directory(area) });
        if (stat.type !== 'file' || stat.size !== size) throw new PdfError('CACHE_CORRUPT');
        const bytes = new Uint8Array(size);
        for (let offset = 0; offset < size; offset += chunkSize) {
          const length = Math.min(chunkSize, size - offset);
          const chunk = await Filesystem.readFile({ path, directory: directory(area), offset, length });
          if (typeof chunk.data !== 'string') throw new PdfError('CACHE_CORRUPT');
          const decoded = unbinary(chunk.data);
          if (decoded.length !== length) throw new PdfError('CACHE_CORRUPT');
          bytes.set(decoded, offset);
        }
        return bytes;
      } catch (error) { if (missing(error)) return null; throw error instanceof PdfError ? error : new PdfError('CACHE_UNAVAILABLE'); }
    },
    async write(area, name, bytes, signal) {
      const path = `${root}/${name}`;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        throwIfAborted(signal);
        const data = binary(bytes.subarray(offset, offset + chunkSize));
        if (offset === 0) await Filesystem.writeFile({ path, directory: directory(area), data, recursive: true });
        else await Filesystem.appendFile({ path, directory: directory(area), data });
      }
      throwIfAborted(signal);
    },
    async remove(area, name) {
      try { await Filesystem.deleteFile({ path: `${root}/${name}`, directory: directory(area) }); }
      catch (error) { if (!missing(error)) throw new PdfError('CACHE_UNAVAILABLE'); }
    },
  };
}

let sharedCache: PdfCache | undefined;
export function getPdfCache(): PdfCache {
  return sharedCache ??= Capacitor.isNativePlatform() ? new NativePdfCache(capacitorPdfFiles()) : new WebPdfCache();
}
export async function clearPdfCache(scope: AccountScope, options: { includePinned?: boolean } = {}): Promise<void> {
  cancelPdfTasks(scope);
  await getPdfCache().clear(scope, options);
}
