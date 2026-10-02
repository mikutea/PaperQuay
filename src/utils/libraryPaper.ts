import type {
  LiteratureAttachment,
  LiteraturePaper,
} from '../types/library';

export interface ResolvedPaperPdfAttachment {
  attachment: LiteratureAttachment;
  path: string;
}

export interface ResolvePaperPdfAttachmentOptions {
  storageDir?: string | null;
}

function cleanPath(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

function joinStorageRelativePath(storageDir: string, relativePath: string): string {
  const separator = storageDir.includes('\\') ? '\\' : '/';
  const normalizedStorageDir = storageDir.replace(/[\\/]+$/, '');
  const normalizedRelativePath = relativePath.replace(/^[\\/]+/, '');

  return normalizedStorageDir
    ? `${normalizedStorageDir}${separator}${normalizedRelativePath}`
    : normalizedRelativePath;
}

function resolveAttachmentPdfPath(
  attachment: LiteratureAttachment,
  options: ResolvePaperPdfAttachmentOptions = {},
): string {
  const storageDir = cleanPath(options.storageDir);
  const relativePath = cleanPath(attachment.relativePath);

  if (storageDir && relativePath) {
    if (/^[\\/]|^[a-z]:/i.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) return '';
    return joinStorageRelativePath(storageDir, relativePath);
  }

  return cleanPath(attachment.storedPath) || cleanPath(attachment.originalPath);
}

export function resolvePaperPdfAttachment(
  paper: LiteraturePaper,
  options: ResolvePaperPdfAttachmentOptions = {},
): ResolvedPaperPdfAttachment | null {
  const pdfAttachments = paper.attachments.filter((attachment) => attachment.kind === 'pdf');

  for (const attachment of pdfAttachments) {
    if (attachment.missing) {
      continue;
    }

    const path = resolveAttachmentPdfPath(attachment, options);

    if (path) {
      return { attachment, path };
    }
  }

  for (const attachment of pdfAttachments) {
    const path = resolveAttachmentPdfPath(attachment, options);

    if (path) {
      return { attachment, path };
    }
  }

  return null;
}

export function paperPdfPath(
  paper: LiteraturePaper,
  options: ResolvePaperPdfAttachmentOptions = {},
): string | null {
  return resolvePaperPdfAttachment(paper, options)?.path ?? null;
}
