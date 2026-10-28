import { invoke } from '../platform/electron/core';

export interface DesktopNoteExportResult {
  status: 'exported' | 'cancelled' | 'nothing-exportable' | 'source-changed' | 'failed' | 'busy';
  noteCount: number; paperCount: number;
  skipped: { entityType: 'paper' | 'note'; index: number; code: string }[];
  code?: string;
}
const safeCode = (value: unknown): value is string => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value);
/** The renderer submits IDs only. Paths, saved AST and image authority stay in
 * main; the response cannot return a selected native destination. */
export async function exportDesktopSavedNotes(noteIds: readonly string[]): Promise<DesktopNoteExportResult> {
  const value = await invoke<DesktopNoteExportResult>('notes_export_rich_archive', { noteIds: [...noteIds] });
  if (!value || typeof value !== 'object' || Object.keys(value).some(key => !['status', 'noteCount', 'paperCount', 'skipped', 'code'].includes(key))
    || !['exported', 'cancelled', 'nothing-exportable', 'source-changed', 'failed', 'busy'].includes(value.status)
    || !Number.isSafeInteger(value.noteCount) || value.noteCount < 0 || value.noteCount > 500
    || !Number.isSafeInteger(value.paperCount) || value.paperCount < 0 || value.paperCount > 500
    || !Array.isArray(value.skipped) || value.skipped.length > 1000 || value.code !== undefined && !safeCode(value.code)
    || value.skipped.some(entry => !entry || typeof entry !== 'object' || Object.keys(entry).sort().join(',') !== 'code,entityType,index'
      || !['paper', 'note'].includes(entry.entityType) || !Number.isSafeInteger(entry.index) || entry.index < 0 || entry.index >= 1000 || !safeCode(entry.code)))
    throw new Error('EXPORT_FAILED');
  return value;
}

const descriptions: Record<string, string> = {
  SAVED_NOTE_UNAVAILABLE: '记录不存在或已删除', UNSUPPORTED_NOTE_FORMAT: '旧笔记未保存结构正文',
  EXPIRED_BLOB_IMAGE: '图片仅有临时 blob，无法证明原始字节', REMOTE_IMAGE_UNSUPPORTED: '包含远程图片，需先保存为受支持的包内图片',
  LOCAL_IMAGE_UNSUPPORTED: '包含本机路径或不支持的图片来源', HASH_IMAGE_UNAVAILABLE: '缺少可信的 hash 图片读取器',
  INVALID_IMAGE_DATA: '图片数据或 hash 校验失败', IMAGE_LIMIT: '图片超出资源限制',
  IMAGE_DECODE_FAILED: '原始图片不能完整解码或解码尺寸不一致',
  UNVERIFIED_RICH_NOTE_RESOURCE: '图片缺少对应字节证据', RICH_RESOURCE_EVIDENCE_MISMATCH: '图片来源与证据不匹配',
  UNSUPPORTED_RICH_NOTE: '包含无法完整表示的结构、属性或引用', INVALID_NOTE_METADATA: '正文或元数据不符合共享结构要求',
  UNMAPPED_NOTE_PAPER: '主关联文献不存在或不能导出', INVALID_PAPER_METADATA: '关联题录不符合共享格式',
  INVALID_LOCAL_PAPER: '关联题录来源标识无效', INVALID_LOCAL_NOTE: '笔记来源标识无效', DELETED_NOTE: '笔记已删除', DUPLICATE_NOTE: '重复笔记标识',
};
export function desktopNoteExportSkipDescription(code: string): string { return descriptions[code] ?? '该记录不能完整导出'; }
