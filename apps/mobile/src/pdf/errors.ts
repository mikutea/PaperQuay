const messages = {
  CANCELLED: '已取消。',
  TIMEOUT: '读取超时，请重试或选择本机 PDF。',
  URL_INVALID: '请输入不含登录信息的公开 HTTPS PDF 链接。',
  NETWORK: '无法读取此链接，可能是网络或网站跨域限制。请重试或选择本机 PDF。',
  REDIRECT: '此链接发生跳转。请使用跳转后的公开 PDF 链接，或选择本机文件。',
  HTTP: '网站未返回可读取的 PDF，请检查链接或选择本机文件。',
  NOT_PDF: '内容不是 PDF。请使用 PDF 文件链接，而不是文献介绍网页。',
  TOO_LARGE: '此 PDF 超过当前 64 MB 的文件上限。',
  TOO_MANY_PAGES: '此 PDF 超过当前 2000 页的阅读上限。',
  INCOMPLETE: '文件长度不完整，请重新获取。',
  SOURCE_CHANGED: '下载期间文件发生变化，请重新检查链接。',
  VERSION_MISMATCH: '文件与所选版本不一致。请选择正确文件，或将它作为新版本添加。',
  INVALID_PDF: 'PDF 无法完整解析，请换用有效文件。',
  READER_UNAVAILABLE: '本设备暂时无法启动 PDF 阅读组件，请重新打开阅读页面后重试。',
  READER_RESOURCE: 'PDF 阅读组件缺少字体或解码资源，请联网重新加载应用后重试。',
  PAGE_RENDER: '此页暂时无法显示，请重新打开阅读页面后重试。',
  PASSWORD: '此 PDF 需要密码，请先在本机解锁后再打开。',
  CACHE_UNAVAILABLE: '本设备暂时无法保存 PDF 缓存。',
  CACHE_FULL: 'PDF 缓存空间已满，请在缓存列表中清理文件后重试。',
  CACHE_CORRUPT: '缓存内容不完整，已停止读取。请重新选择文件或下载。',
  CACHE_MISSING: '此文件已不在本机缓存中，请重新获取。',
  TEXT_LIMIT: '所选文本范围过大，请改为当前页或较短选段。',
  NO_TEXT: '此范围没有可提取文字。扫描页需要先完成文字识别。',
  SELECTION_LIMIT: '选段过长，请缩小到一页内的较短范围。',
  POSITION_FAILED: '阅读位置尚未保存，请重试后再离开。',
  ANNOTATION_CHANGED: '这条批注已在其他位置修改。请保留当前文字，重新打开批注后再保存。',
  ACCOUNT_CHANGED: '账号或阅读会话已改变，请重新打开文献。',
} as const;

export type PdfErrorCode = keyof typeof messages;

export class PdfError extends Error {
  readonly code: PdfErrorCode;
  constructor(code: PdfErrorCode) {
    super(messages[code]);
    this.name = 'PdfError';
    this.code = code;
  }
}

export function pdfError(error: unknown): PdfError {
  if (error instanceof PdfError) return error;
  if (error instanceof Error && error.name === 'AbortError') return new PdfError('CANCELLED');
  return new PdfError('INVALID_PDF');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PdfError('CANCELLED');
}

/** Abort and timer listeners are always removed, including after an early error. */
export function boundedSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  close: () => void;
  error: () => PdfError;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (parent?.aborted) abort();
  else parent?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    close: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', abort);
    },
    error: () => new PdfError(timedOut ? 'TIMEOUT' : parent?.aborted ? 'CANCELLED' : 'NETWORK'),
  };
}
