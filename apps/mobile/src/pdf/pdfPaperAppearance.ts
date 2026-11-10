export type PdfPaperAppearance = 'theme' | 'soft-original' | 'original';

export const PDF_PAPER_APPEARANCE_KEY = 'paperquay-pdf-paper-appearance-v1';
type PaperStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function pdfPaperAppearance(value: unknown): PdfPaperAppearance {
  return value === 'original' || value === 'soft-original' ? value : 'theme';
}

export function readPdfPaperAppearance(storage?: Pick<PaperStorage, 'getItem'>): PdfPaperAppearance {
  try { return pdfPaperAppearance((storage ?? globalThis.localStorage).getItem(PDF_PAPER_APPEARANCE_KEY)); }
  catch { return 'theme'; }
}

export function writePdfPaperAppearance(value: PdfPaperAppearance, storage?: Pick<PaperStorage, 'setItem'>): void {
  try { (storage ?? globalThis.localStorage).setItem(PDF_PAPER_APPEARANCE_KEY, pdfPaperAppearance(value)); }
  catch { /* The current reader still applies the choice when preference storage is unavailable. */ }
}
