import { plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import {
  ENTITY_TYPES, isPlainObject, SYNC_LIMITS, validateEntityData,
  type PaperData, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import {
  exportLibraryArchive, LIBRARY_TRANSFER_LIMITS, LibraryTransferError, parseLibraryArchive,
  type LibraryArchive,
} from './libraryTransfer.ts';
import { normalizeDoi } from './doiLookup.ts';
import { guardBibtex } from './bibtexGuard.ts';

export type BibliographyFormat = 'bibtex' | 'ris';
export type BibliographyWarningCode =
  | 'UNSUPPORTED_FIELDS' | 'TYPE_NOT_PRESERVED' | 'LATEX_NORMALIZED' | 'LATEX_PRESERVED'
  | 'AUTHOR_STRUCTURE_FLATTENED' | 'DATE_PARTS_DROPPED' | 'LINE_BREAKS_NORMALIZED'
  | 'LIBRARY_STATE_OMITTED' | 'NOTES_OMITTED';
export interface BibliographyWarning {
  code: BibliographyWarningCode;
  /** One-based archive order (p1, p2, ...); null describes the whole file. */
  record: number | null;
  /** ASCII field names only; never values, citation keys, paths or identities. */
  fields: string[];
  message: string;
}
export interface BibliographyExportSummary {
  papers: number;
  omittedNotes: number;
  omittedDeleted: number;
  omittedUnsupported: number;
  conflicted: number;
  scope: 'visible-saved-paper-metadata';
}
export type BibliographyTransferErrorCode =
  | 'UNSUPPORTED_FORMAT' | 'INVALID_BIBTEX' | 'INVALID_RIS' | 'INVALID_RECORD'
  | 'ARCHIVE_TOO_LARGE' | 'TOO_MANY_RECORDS' | 'EMPTY_BIBLIOGRAPHY' | 'INVALID_EXISTING_DATA';
export class BibliographyTransferError extends Error {
  constructor(readonly code: BibliographyTransferErrorCode, readonly record: number | null = null) {
    super(code);
    this.name = 'BibliographyTransferError';
  }
}

const messages: Record<BibliographyWarningCode, string> = {
  UNSUPPORTED_FIELDS: '这些字段不在当前题录结构中，导入后不会保留。',
  TYPE_NOT_PRESERVED: '当前题录不保存文献类型；导出统一使用通用类型，不推断期刊论文或图书类型。',
  LATEX_NORMALIZED: 'LaTeX 文本已转换为普通文字；排版命令及大小写保护标记不会保留。',
  LATEX_PRESERVED: '含有未支持的 LaTeX 命令，已保留该字段原文，未保证排版还原。',
  AUTHOR_STRUCTURE_FLATTENED: '作者按显示名称保存和导出；不保留姓、名拆分或机构作者标记。',
  DATE_PARTS_DROPPED: '当前只保存年份，日期中的月、日等部分不会保留。',
  LINE_BREAKS_NORMALIZED: '这些字段的换行或空白需要规范化；分行排版和首尾空白可能不会保留。',
  LIBRARY_STATE_OMITTED: '书目文件不包含收藏、阅读状态、标签、合集和阅读队列。',
  NOTES_OMITTED: '书目文件只包含论文题录，不包含笔记、批注、PDF 或阅读进度。',
};
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const unpairedSurrogates = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
function checkBytes(text: string): void {
  if (text.length > LIBRARY_TRANSFER_LIMITS.maxBytes || byteLength(text) > LIBRARY_TRANSFER_LIMITS.maxBytes) {
    throw new BibliographyTransferError('ARCHIVE_TOO_LARGE');
  }
}
function checkText(text: string, record: number | null = null): void {
  if (invalidControls.test(text) || unpairedSurrogates.test(text)) {
    throw new BibliographyTransferError('INVALID_RECORD', record);
  }
}
function checkedFormat(format: BibliographyFormat): void {
  if (format !== 'bibtex' && format !== 'ris') throw new BibliographyTransferError('UNSUPPORTED_FORMAT');
}
function warning(warnings: BibliographyWarning[], code: BibliographyWarningCode,
  record: number | null, fields: string[] = []): void {
  const safeFields = [...new Set(fields.map((field) => /^[A-Za-z0-9_:+-]{1,64}$/.test(field) ? field : 'custom-field'))];
  const previous = warnings.find((item) => item.code === code && item.record === record);
  if (previous) previous.fields = [...new Set([...previous.fields, ...safeFields])];
  else warnings.push({ code, record, fields: safeFields, message: messages[code] });
}
function normalizeBibliographicDoi(value: string | null, record: number): string | null {
  if (value === null || value.trim() === '') return null;
  try { return normalizeDoi(value); }
  catch { throw new BibliographyTransferError('INVALID_RECORD', record); }
}
function checkedPaper(data: PaperData, record: number): PaperData {
  if (!data.title.trim() || [...data.authors, ...data.keywords].some((value) => !value.trim())) {
    throw new BibliographyTransferError('INVALID_RECORD', record);
  }
  for (const value of [data.title, data.doi, data.year, data.publication, data.abstractText, ...data.authors, ...data.keywords]) {
    if (value !== null) checkText(value, record);
  }
  if (!validateEntityData('paper', data).ok) throw new BibliographyTransferError('INVALID_RECORD', record);
  return data;
}

interface RawBibEntry {
  type: string;
  label: string;
  properties: Record<string, string | number>;
  annotations?: Record<string, unknown>;
}
interface BibConfig {
  parse: { strict: boolean; sentenceCase: string };
  constants: {
    defaultStrings: Record<string, string>;
    formatting: Record<string, string[]>;
    commands: Record<string, string>;
    mathCommands: Record<string, string>;
    diacritics: Record<string, string>;
    formattingCommands: Record<string, string>;
    formattingEnvs: Record<string, string>;
    argumentCommands: Record<string, unknown>;
  };
}
const bibConfig = plugins.config.get('@bibtex') as unknown as BibConfig;

/** Values are parsed by the installed BibTeX grammar; no automatic URL/input detection is used. */
function latexText(raw: string, field: string, record: number, warnings: BibliographyWarning[]): string {
  if (raw !== raw.trim()) warning(warnings, 'LINE_BREAKS_NORMALIZED', record, [field]);
  if (!/[{}\\$~]/.test(raw)) return raw.trim();
  const constants = bibConfig.constants;
  const commands = [...raw.matchAll(/\\([A-Za-z]+|.)/g)].map((match) => match[1]);
  const unsupported = commands.some((command) => !/^[&%$#_{}]$/.test(command)
    && command !== 'begin' && command !== 'end'
    && ![constants.commands, constants.mathCommands, constants.diacritics,
      constants.formattingCommands, constants.formattingEnvs, constants.argumentCommands]
      .some((known) => Object.hasOwn(known, command)))
    || [...raw.matchAll(/\\begin\s*\{([^{}]+)\}/g)]
      .some((match) => !Object.hasOwn(constants.formattingEnvs, match[1]));
  if (unsupported) {
    warning(warnings, 'LATEX_PRESERVED', record, [field]);
    return raw.trim();
  }
  const previousFormatting = { ...constants.formatting };
  const previousStrict = bibConfig.parse.strict;
  const previousSentenceCase = bibConfig.parse.sentenceCase;
  try {
    // Synchronous, restored in finally: the adapter returns plain text, never
    // plugin-generated HTML or externally supplied command implementations.
    for (const key of Object.keys(constants.formatting)) constants.formatting[key] = ['', ''];
    bibConfig.parse.strict = false;
    bibConfig.parse.sentenceCase = 'never';
    const converted = plugins.input.data({
      type: 'misc', label: 'paperquay-value', properties: { title: raw }, annotations: {},
    }, '@biblatex/entry+object') as unknown as { title?: string }[];
    if (converted.length !== 1 || typeof converted[0].title !== 'string') throw new Error();
    const value = converted[0].title.trim();
    warning(warnings, 'LATEX_NORMALIZED', record, [field]);
    if (JSON.stringify(raw.match(/\s+/g)) !== JSON.stringify(value.match(/\s+/g))) {
      warning(warnings, 'LINE_BREAKS_NORMALIZED', record, [field]);
    }
    return value;
  } catch {
    throw new BibliographyTransferError('INVALID_RECORD', record);
  } finally {
    Object.assign(constants.formatting, previousFormatting);
    bibConfig.parse.strict = previousStrict;
    bibConfig.parse.sentenceCase = previousSentenceCase;
  }
}

/** Split only delimiters outside nested protected names/keywords, after file parsing. */
function splitProtected(value: string, mode: 'authors' | 'keywords'): string[] {
  const result: string[] = []; let start = 0; let depth = 0;
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '\\') { index++; continue; }
    if (value[index] === '{') depth++;
    else if (value[index] === '}') depth--;
    else if (depth === 0) {
      if (mode === 'keywords' && value[index] === ',') {
        result.push(value.slice(start, index).trim());
        start = index + 1;
      } else if (mode === 'authors' && /\s/.test(value[index])) {
        // Inspect each whitespace run once. Matching \s+ from every character
        // rescans the suffix quadratically on large, otherwise valid fields.
        let end = index + 1;
        while (end < value.length && /\s/.test(value[end])) end++;
        if (value.slice(end, end + 3).toLowerCase() === 'and'
          && end + 3 < value.length && /\s/.test(value[end + 3])) {
          result.push(value.slice(start, index).trim());
          end += 4;
          while (end < value.length && /\s/.test(value[end])) end++;
          start = end;
        }
        // The untouched original slice still supplies every name's text.
        index = end - 1;
      }
    }
  }
  result.push(value.slice(start).trim());
  return result.filter((part) => part !== '');
}

function yearOnly(value: string | null, field: string, record: number, warnings: BibliographyWarning[]): string | null {
  if (value === null || value === '') return null;
  const match = /^(\d{4})(?:[-/]\d{0,2}){1,3}(?:\/.*)?$/.exec(value);
  if (match) {
    if (value !== match[1]) warning(warnings, 'DATE_PARTS_DROPPED', record, [field]);
    return match[1];
  }
  return value;
}

function parseBibtex(text: string, warnings: BibliographyWarning[]): PaperData[] {
  let raw: RawBibEntry[]; let checked: ReturnType<typeof guardBibtex>;
  try {
    checked = guardBibtex(text, bibConfig.constants.defaultStrings, {
      maxBytes: LIBRARY_TRANSFER_LIMITS.maxBytes, maxRecords: LIBRARY_TRANSFER_LIMITS.maxPapers,
    });
    raw = plugins.input.data(checked.source, '@bibtex/text') as unknown as RawBibEntry[];
    if (!Array.isArray(raw) || raw.length !== checked.records) throw new Error();
  } catch (error) {
    throw new BibliographyTransferError(error instanceof RangeError && error.message === 'TOO_MANY_RECORDS'
      ? 'TOO_MANY_RECORDS' : 'INVALID_BIBTEX');
  }
  if (checked.preamble) warning(warnings, 'UNSUPPORTED_FIELDS', null, ['preamble']);
  return raw.map((entry, index) => {
    const record = index + 1; const used = new Set<string>();
    const get = (...fields: string[]): string | null => {
      const field = fields.find((key) => Object.hasOwn(entry.properties, key)
        && String(entry.properties[key]).trim() !== '');
      if (!field) return null;
      used.add(field);
      return latexText(String(entry.properties[field]), field, record, warnings);
    };
    const rawList = (field: string, mode: 'authors' | 'keywords'): string[] => {
      if (!Object.hasOwn(entry.properties, field)) return [];
      used.add(field);
      return splitProtected(String(entry.properties[field]), mode)
        .map((value) => latexText(value, field, record, warnings));
    };
    const title = get('title');
    if (title === null) throw new BibliographyTransferError('INVALID_RECORD', record);
    const rawYear = get('year', 'date');
    const year = used.has('date') ? yearOnly(rawYear, 'date', record, warnings) : rawYear;
    const authors = rawList('author', 'authors');
    const abstractText = Object.hasOwn(entry.properties, 'abstract')
      ? latexText(String(entry.properties.abstract), 'abstract', record, warnings) : null;
    if (abstractText !== null) used.add('abstract');
    const data: PaperData = {
      title, doi: normalizeBibliographicDoi(get('doi'), record), year,
      publication: get('journal', 'journaltitle', 'booktitle'),
      abstractText, authors, keywords: rawList('keywords', 'keywords'),
    };
    const omitted = Object.keys(entry.properties).filter((field) => !used.has(field));
    omitted.push('citation-key');
    if (entry.annotations && Object.keys(entry.annotations).length) omitted.push('annotations');
    warning(warnings, 'UNSUPPORTED_FIELDS', record, omitted);
    warning(warnings, 'TYPE_NOT_PRESERVED', record, ['entry-type']);
    if (authors.length) warning(warnings, 'AUTHOR_STRUCTURE_FLATTENED', record, ['author']);
    return checkedPaper(data, record);
  });
}

interface RisField { tag: string; value: string }
function parseRis(text: string, warnings: BibliographyWarning[]): PaperData[] {
  const records: RisField[][] = [];
  let fields: RisField[] | null = null;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const tag = /^([A-Z][A-Z0-9]) {1,2}- ?(.*)$/.exec(line);
    if (tag) {
      const [, key, value] = tag;
      if (key === 'TY') {
        if (fields !== null || !/^[A-Z][A-Z0-9]{0,15}$/.test(value.trim())) {
          throw new BibliographyTransferError('INVALID_RIS', records.length + 1);
        }
        if (records.length >= LIBRARY_TRANSFER_LIMITS.maxPapers) throw new BibliographyTransferError('TOO_MANY_RECORDS');
        fields = [{ tag: key, value: value.trim() }];
      } else if (key === 'ER') {
        if (!fields || value.trim()) throw new BibliographyTransferError('INVALID_RIS', records.length + 1);
        records.push(fields); fields = null;
      } else {
        if (!fields || fields.length >= 1024) throw new BibliographyTransferError('INVALID_RIS', records.length + 1);
        fields.push({ tag: key, value });
      }
    } else if (line.trim()) {
      if (!fields || fields.length < 2 || /^\s*[A-Za-z0-9]{2}\s*-/.test(line)) {
        throw new BibliographyTransferError('INVALID_RIS', records.length + 1);
      }
      // Standard wrapped fields may be unindented or have a six-space prefix.
      fields[fields.length - 1].value += '\n' + line.replace(/^ {6}/, '');
    } else if (fields && fields.length > 1) fields[fields.length - 1].value += '\n';
  }
  if (fields !== null) throw new BibliographyTransferError('INVALID_RIS', records.length + 1);
  return records.map((recordFields, index) => {
    const record = index + 1; const used = new Set<RisField>();
    const single = (tags: string[], allowEmpty = false): string | null => {
      const matches = recordFields.filter((field) => tags.includes(field.tag) && (allowEmpty || field.value.trim() !== ''));
      if (!matches.length) return null;
      const values = new Set(matches.map((field) => field.value.trim()));
      if (values.size > 1) throw new BibliographyTransferError('INVALID_RECORD', record);
      matches.forEach((field) => used.add(field));
      if (matches.some((field) => field.value !== field.value.trim())) {
        warning(warnings, 'LINE_BREAKS_NORMALIZED', record, matches.map((field) => field.tag));
      }
      return matches[0].value.trim();
    };
    const one = (...tags: string[]) => single(tags);
    const many = (...tags: string[]) => recordFields.filter((field) => tags.includes(field.tag))
      .map((field) => {
        used.add(field);
        if (field.value !== field.value.trim()) warning(warnings, 'LINE_BREAKS_NORMALIZED', record, [field.tag]);
        return field.value.trim();
      }).filter(Boolean);
    const title = one('TI', 'T1', 'CT');
    if (title === null) throw new BibliographyTransferError('INVALID_RECORD', record);
    let publication: string | null = null;
    for (const tag of ['JF', 'JO', 'JT', 'T2', 'BT']) {
      publication = one(tag);
      if (publication !== null) break;
    }
    const dates = ['PY', 'Y1', 'DA'].map((tag) => ({ tag, value: one(tag) }))
      .filter((date): date is { tag: string; value: string } => date.value !== null);
    const years = dates.map(({ tag, value }) => yearOnly(value, tag, record, warnings)!);
    if (new Set(years).size > 1) throw new BibliographyTransferError('INVALID_RECORD', record);
    const authors = many('AU', 'A1');
    const data: PaperData = {
      title, doi: normalizeBibliographicDoi(one('DO'), record), year: years[0] ?? null,
      publication, abstractText: single(['AB', 'N2'], true), authors, keywords: many('KW'),
    };
    const omitted = recordFields.filter((field) => field.tag !== 'TY' && !used.has(field)).map((field) => field.tag);
    if (omitted.length) warning(warnings, 'UNSUPPORTED_FIELDS', record, omitted);
    warning(warnings, 'TYPE_NOT_PRESERVED', record, ['TY']);
    if (authors.length) warning(warnings, 'AUTHOR_STRUCTURE_FLATTENED', record, ['AU', 'A1']);
    return checkedPaper(data, record);
  });
}

/** Pure conversion only. The caller must preview and use the existing atomic import path. */
export function parseBibliography(text: string, format: BibliographyFormat): {
  archive: LibraryArchive; warnings: BibliographyWarning[];
} {
  checkedFormat(format);
  if (typeof text !== 'string') throw new BibliographyTransferError(format === 'bibtex' ? 'INVALID_BIBTEX' : 'INVALID_RIS');
  checkBytes(text); checkText(text);
  const warnings: BibliographyWarning[] = [];
  const papers = (format === 'bibtex' ? parseBibtex : parseRis)(text.replace(/^\uFEff/, ''), warnings);
  if (!papers.length) throw new BibliographyTransferError('EMPTY_BIBLIOGRAPHY');
  try {
    const archive = parseLibraryArchive(JSON.stringify({
      format: 'paperquay-library', version: 1,
      papers: papers.map((data, index) => ({ ref: 'p' + (index + 1), data })), notes: [],
    }));
    return { archive, warnings };
  } catch (error) {
    throw new BibliographyTransferError(error instanceof LibraryTransferError && error.code === 'ARCHIVE_TOO_LARGE'
      ? 'ARCHIVE_TOO_LARGE' : 'INVALID_RECORD');
  }
}

function paperProjection(entities: readonly VisibleEntity[]): {
  papers: VisibleEntity[]; summary: BibliographyExportSummary;
} {
  const papers: VisibleEntity[] = [];
  const summary: BibliographyExportSummary = { papers: 0, omittedNotes: 0, omittedDeleted: 0,
    omittedUnsupported: 0, conflicted: 0, scope: 'visible-saved-paper-metadata' };
  if (!Array.isArray(entities) || entities.length > SYNC_LIMITS.maxLocalEntities) {
    throw new BibliographyTransferError('INVALID_EXISTING_DATA');
  }
  for (let index = 0; index < entities.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(entities, index);
    const value: unknown = descriptor && 'value' in descriptor ? descriptor.value : null;
    if (!isPlainObject(value) || Object.values(Object.getOwnPropertyDescriptors(value)).some((item) => !('value' in item))
      || !ENTITY_TYPES.includes(value.entityType as VisibleEntity['entityType']) || typeof value.deleted !== 'boolean') {
      throw new BibliographyTransferError('INVALID_EXISTING_DATA');
    }
    if (value.deleted) summary.omittedDeleted++;
    else if (value.entityType === 'paper') papers.push(value as unknown as VisibleEntity);
    else if (value.entityType === 'note') summary.omittedNotes++;
    else summary.omittedUnsupported++;
  }
  summary.papers = papers.length;
  summary.conflicted = papers.filter((paper) => paper.status === 'conflict').length;
  return { papers, summary };
}
const bibEscapes: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&',
  '%': '\\%', '#': '\\#', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}',
};
const escapeBib = (value: string) => value.replace(/[\\{}$&%#_^~]/g, (character) => bibEscapes[character]);
function renderBibtex(data: PaperData, index: number, warnings: BibliographyWarning[]): string {
  const fields: [string, string][] = [['title', escapeBib(data.title)]];
  if (data.authors.length) fields.push(['author', data.authors.map((name) => '{' + escapeBib(name) + '}').join(' and ')]);
  if (data.year !== null) fields.push(['year', escapeBib(data.year)]);
  if (data.doi !== null) fields.push(['doi', escapeBib(data.doi)]);
  if (data.publication !== null) fields.push(['journal', escapeBib(data.publication)]);
  if (data.abstractText !== null) fields.push(['abstract', escapeBib(data.abstractText)]);
  if (data.keywords.length) fields.push(['keywords', data.keywords.map((word) => '{' + escapeBib(word) + '}').join(', ')]);
  // The values remain text. Any source backslash/brace is escaped before the
  // syntactic braces are added; neither a field nor an entry can be injected.
  for (const [field, value] of fields) {
    if (/[{}\\$~]/.test(value) && /(?:[\r\n\t\u2028\u2029]|\s{2,})/.test(value)) {
      warning(warnings, 'LINE_BREAKS_NORMALIZED', index, [field]);
    }
  }
  for (const [field, values] of [
    ['title', [data.title]], ['year', [data.year]], ['journal', [data.publication]],
    ['abstract', [data.abstractText]], ['author', data.authors], ['keywords', data.keywords],
  ] as const) {
    if (values.some((value) => value !== null && value !== value.trim())) {
      warning(warnings, 'LINE_BREAKS_NORMALIZED', index, [field]);
    }
  }
  return '@misc{p' + index + ',\n' + fields.map(([key, value]) => '  ' + key + ' = {' + value + '}').join(',\n') + '\n}';
}
function renderRis(data: PaperData, index: number, warnings: BibliographyWarning[]): string {
  const fields: [string, string][] = [['TY', 'GEN'], ['TI', data.title]];
  data.authors.forEach((name) => fields.push(['AU', name]));
  if (data.year !== null) {
    yearOnly(data.year, 'PY', index, warnings);
    fields.push(['PY', data.year]);
  }
  if (data.doi !== null) fields.push(['DO', data.doi]);
  if (data.publication !== null) fields.push(['T2', data.publication]);
  if (data.abstractText !== null) fields.push(['AB', data.abstractText]);
  data.keywords.forEach((word) => fields.push(['KW', word]));
  return fields.map(([tag, value]) => {
    const plain = value.replace(/[\r\n\t\u2028\u2029]+/g, ' ').trim();
    if (plain !== value) warning(warnings, 'LINE_BREAKS_NORMALIZED', index, [tag]);
    return tag + '  - ' + plain;
  }).join('\n') + '\nER  -';
}

/** Export the saved visible paper projection, including saved pending edits, never editor drafts. */
export function exportBibliography(entities: readonly VisibleEntity[], format: BibliographyFormat): {
  text: string; summary: BibliographyExportSummary; warnings: BibliographyWarning[];
} {
  checkedFormat(format);
  const { papers, summary } = paperProjection(entities);
  if (papers.length > LIBRARY_TRANSFER_LIMITS.maxPapers) throw new BibliographyTransferError('TOO_MANY_RECORDS');
  const warnings: BibliographyWarning[] = [];
  if (summary.omittedNotes || summary.omittedUnsupported) warning(warnings, 'NOTES_OMITTED', null);
  let archive: LibraryArchive;
  try {
    // Excluding notes first is essential: their count/body bytes must not
    // prevent a small bibliography export.
    archive = exportLibraryArchive(papers).archive;
  } catch (error) {
    throw new BibliographyTransferError(error instanceof LibraryTransferError && error.code === 'ARCHIVE_TOO_LARGE'
      ? 'ARCHIVE_TOO_LARGE' : 'INVALID_EXISTING_DATA');
  }
  const rendered = archive.papers.map(({ data }, index) => {
    const record = index + 1;
    const clean = checkedPaper({ ...data, doi: normalizeBibliographicDoi(data.doi, record) }, record);
    warning(warnings, 'TYPE_NOT_PRESERVED', record, [format === 'bibtex' ? 'entry-type' : 'TY']);
    if (data.authors.length) warning(warnings, 'AUTHOR_STRUCTURE_FLATTENED', record, ['authors']);
    if (data.organization) warning(warnings, 'LIBRARY_STATE_OMITTED', record, ['organization']);
    return format === 'bibtex' ? renderBibtex(clean, record, warnings) : renderRis(clean, record, warnings);
  });
  const text = rendered.length ? rendered.join('\n\n') + '\n' : '';
  checkBytes(text);
  return { text, summary, warnings };
}
