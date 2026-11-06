/**
 * Resource/strictness guard around Citation.js, not a replacement BibTeX parser.
 * The upstream parser intentionally tolerates mismatched delimiters, repeated
 * fields and undefined strings. Reject those before it can discard information
 * or expand a short macro chain into an unbounded value.
 */
export function guardBibtex(text: string, defaults: Record<string, string>, limits: {
  maxBytes: number; maxRecords: number;
}): { records: number; preamble: boolean; source: string } {
  let cursor = 0; let records = 0; let expanded = 0; let preamble = false;
  const ignoredComments: [number, number][] = [];
  const macros = new Map(Object.entries(defaults).map(([key, value]) => [key.toLowerCase(), value.length]));
  const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
  const fail = (): never => { throw new SyntaxError('INVALID_BIBTEX'); };
  const space = () => {
    while (cursor < text.length) {
      if (/\s/.test(text[cursor])) cursor++;
      else if (text[cursor] === '%') {
        while (cursor < text.length && text[cursor] !== '\n' && text[cursor] !== '\r') cursor++;
      } else break;
    }
  };
  const expect = (character: string) => {
    if (text[cursor] !== character) fail();
    cursor++;
  };
  const identifier = (): string => {
    const match = /^[A-Za-z_][A-Za-z0-9_:+-]*/.exec(text.slice(cursor));
    if (!match) return fail();
    cursor += match[0].length;
    const name = match[0].toLowerCase();
    if (name.length > 128 || unsafe.has(name)) fail();
    return name;
  };
  const lengthWithinLimit = (length: number): number => {
    if (!Number.isSafeInteger(length) || length > limits.maxBytes) fail();
    return length;
  };
  const literal = (): number => {
    const delimiter = text[cursor++];
    const close = delimiter === '{' ? '}' : '"';
    let depth = delimiter === '{' ? 1 : 0; let length = 0;
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '\\') {
        if (cursor >= text.length) return fail();
        // Keep both code units: the real parser interprets the escape later.
        cursor++; length += 2;
      } else if (character === '{') {
        depth++; if (depth > 64) fail();
        length++;
      } else if (character === '}') {
        if (depth === 0) return fail();
        depth--;
        if (delimiter === '{' && depth === 0) return lengthWithinLimit(length);
        length++;
      } else if (character === close && delimiter === '"' && depth === 0) {
        return lengthWithinLimit(length);
      } else length++;
    }
    return fail();
  };
  const expression = (): number => {
    let length = 0;
    while (true) {
      space();
      if (text[cursor] === '{' || text[cursor] === '"') length += literal();
      else {
        const numeric = /^-?\d+/.exec(text.slice(cursor));
        if (numeric) {
          // A leading-zero literal would be coerced by Citation.js; require
          // it to be quoted so its exact spelling is not silently lost.
          if (!/^-?(?:0|[1-9]\d*)$/.test(numeric[0]) || numeric[0].length > 15) fail();
          cursor += numeric[0].length; length += numeric[0].length;
        } else {
          const name = identifier();
          const known = macros.get(name);
          if (known === undefined) return fail();
          length += known;
        }
      }
      lengthWithinLimit(length); space();
      if (text[cursor] !== '#') return length;
      cursor++;
    }
  };
  const comment = (close: string) => {
    let depth = 1;
    const open = close === '}' ? '{' : '(';
    while (cursor < text.length) {
      const character = text[cursor++];
      if (character === '\\') cursor++;
      else if (character === open) {
        depth++; if (depth > 64) fail();
      } else if (character === close && --depth === 0) return;
    }
    fail();
  };
  while (true) {
    space();
    if (cursor === text.length) {
      let previous = 0;
      const source = ignoredComments.map(([start, end]) => {
        const kept = text.slice(previous, start);
        previous = end;
        return kept;
      }).concat(text.slice(previous)).join('\n');
      return { records, preamble, source };
    }
    const directiveStart = cursor;
    expect('@'); space();
    const type = identifier(); space();
    const opening = text[cursor++];
    if (opening !== '{' && opening !== '(') return fail();
    const close = opening === '{' ? '}' : ')'; space();
    if (type === 'comment') {
      comment(close);
      ignoredComments.push([directiveStart, cursor]);
      continue;
    }
    if (type === 'preamble') {
      preamble = true; expanded += expression(); space();
      if (text[cursor] === ',') { cursor++; space(); }
      expect(close);
    } else if (type === 'string') {
      const key = identifier(); space(); expect('='); space();
      const length = expression();
      macros.set(key, length); expanded += length; space();
      if (text[cursor] === ',') { cursor++; space(); }
      expect(close);
    } else {
      records++;
      if (records > limits.maxRecords) throw new RangeError('TOO_MANY_RECORDS');
      const labelStart = cursor;
      while (cursor < text.length && text[cursor] !== ',' && !/\s/.test(text[cursor])) {
        if (/[{}()"\\@]/.test(text[cursor])) fail();
        cursor++;
      }
      if (cursor === labelStart || cursor - labelStart > 1024) fail();
      space(); expect(','); space();
      const fields = new Set<string>();
      while (text[cursor] !== close) {
        const field = identifier();
        if (fields.has(field) || fields.size >= 256) fail();
        fields.add(field); space(); expect('='); space();
        expanded += expression(); lengthWithinLimit(expanded); space();
        if (text[cursor] === ',') { cursor++; space(); }
        else if (text[cursor] !== close) fail();
      }
      expect(close);
    }
    lengthWithinLimit(expanded);
  }
}
