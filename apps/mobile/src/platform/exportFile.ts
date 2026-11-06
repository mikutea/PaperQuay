import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';
import type {AccountScope} from '../storage/accountStore.ts';
import {beginScopedExport,ScopedExportError} from './exportScope.ts';

export class FileExportError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'CHANGED' | 'FAILED') {
    super(code); this.name = 'FileExportError';
  }
}

export interface TextFileExport {
  name: string;
  text: string;
  mime: 'application/json' | 'text/markdown' | 'application/x-bibtex' | 'application/x-research-info-systems';
}
export interface ExportRuntime {
  native: boolean;
  available: () => boolean;
  canShare: () => Promise<boolean>;
  write: (path: string, text: string) => Promise<string>;
  share: (uri: string) => Promise<void>;
  remove: (path: string) => Promise<void>;
  download: (file: TextFileExport) => void;
  id: () => string;
}

export function exportFilename(title: string, extension: 'md' | 'json' | 'bib' | 'ris' | 'docx'): string {
  const stem = title.normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '-')
    .replace(/^\.+|[.\s]+$/g, '').trim().slice(0, 80).replace(/[.\s]+$/g, '') || 'PaperQuay';
  const safeStem = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(stem) ? `PaperQuay-${stem}` : stem;
  return `${safeStem}.${extension}`;
}

function browserDownload(file: TextFileExport) {
  const url = URL.createObjectURL(new Blob([file.text], { type: `${file.mime};charset=utf-8` }));
  const link = document.createElement('a');
  try {
    link.href = url; link.download = file.name; link.hidden = true;
    document.body.append(link); link.click();
  } finally {
    link.remove();
    // Allow the browser download consumer to acquire the Blob before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

const runtime: ExportRuntime = {
  native: Capacitor.isNativePlatform(),
  available: () => ['Filesystem', 'Share'].every((name) => Capacitor.isPluginAvailable(name)),
  canShare: async () => (await Share.canShare()).value,
  write: async (path, text) => (await Filesystem.writeFile({ path, data: text, directory: Directory.Cache,
    encoding: Encoding.UTF8, recursive: true })).uri,
  share: async (uri) => { await Share.share({ files: [uri], dialogTitle: '导出 PaperQuay 文件' }); },
  remove: async (path) => { await Filesystem.deleteFile({ path, directory: Directory.Cache }); },
  download: browserDownload,
  id: () => crypto.randomUUID(),
};

/** The guard is checked again after every preparation await, before opening external UI. */
export async function exportTextFile(file: TextFileExport, current: () => boolean,
  platform: ExportRuntime = runtime, scope?:AccountScope): Promise<'download' | 'share'> {
  const guard = () => { if (!current()) throw new FileExportError('CHANGED'); };
  guard();
  if (!platform.native) {
    platform.download(file); return 'download';
  }
  if (!platform.available()) throw new FileExportError('UNAVAILABLE');
  let operation:ReturnType<typeof beginScopedExport>|undefined;
  let path: string | null = null;
  let opened = false;
  try {
    operation=beginScopedExport(scope,current);
    if (!await platform.canShare()) throw new FileExportError('UNAVAILABLE');
    guard();operation.check();
    const extension = ({ 'application/json': 'json', 'text/markdown': 'md',
      'application/x-bibtex': 'bib', 'application/x-research-info-systems': 'ris' } as const)[file.mime];
    const name = exportFilename(file.name.replace(/\.(json|md|bib|ris)$/i, ''), extension);
    const id=platform.id();if(!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw new FileExportError('FAILED');
    path = `${operation.directory}/${id}/${name}`;
    const uri = await platform.write(path, file.text);
    guard();operation.check();operation.prepared();
    opened = true;
    await platform.share(uri);
    return 'share';
  } catch (error) {
    if(error instanceof ScopedExportError)throw new FileExportError(error.code==='LEGACY_UNOWNED'?'FAILED':error.code);
    if (error instanceof FileExportError) throw error;
    throw new FileExportError('FAILED');
  } finally {
    // Share completion does not guarantee that the receiving app has read the file yet.
    // Once sharing is invoked, keep the file in OS-managed cache for the possible recipient.
    if (path && !opened) await platform.remove(path).catch(() => undefined);
    operation?.release();
  }
}
