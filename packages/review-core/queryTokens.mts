// Query tokenization shared by desktop and mobile; no editor or platform dependencies.
export function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  // CJK Unified Ideographs (incl. extension A) + common kana ranges.
  return (
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * Tokenize a query into search tokens.
 * - Latin/number runs become whole-word tokens (length >= 2).
 * - CJK runs are split into overlapping bi-grams so Chinese queries can match
 *   substrings of titles/abstracts instead of failing as one long string.
 *   Single-character CJK runs fall back to the single char.
 */
export function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  const tokens = new Set<string>();
  // Split on whitespace and punctuation; keep latin/number and CJK content.
  const segments = normalized
    .split(/[\s,.;:!?()[\]{}"'`~，。；：！？、（）【】《》<>/\\|@#$%^&*+=_-]+/)
    .filter(Boolean);

  for (const segment of segments) {
    let buffer = '';
    const flushLatin = () => {
      if (buffer.length >= 2) {
        tokens.add(buffer);
      } else if (buffer.length === 1 && /[a-z0-9]/.test(buffer)) {
        // keep single-letter/number only if it is alphanumeric and meaningful
        // (skip to reduce noise) — require length >= 2 instead.
      }
      buffer = '';
    };

    let cjkRun = '';
    const flushCjk = () => {
      if (cjkRun.length === 1) {
        tokens.add(cjkRun);
      } else {
        for (let i = 0; i < cjkRun.length - 1; i += 1) {
          tokens.add(cjkRun.slice(i, i + 2));
        }
      }
      cjkRun = '';
    };

    for (const char of segment) {
      if (isCjkChar(char)) {
        flushLatin();
        cjkRun += char;
      } else {
        flushCjk();
        buffer += char;
      }
    }
    flushLatin();
    flushCjk();
  }

  return Array.from(tokens);
}
