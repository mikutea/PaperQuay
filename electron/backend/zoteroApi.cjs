const path = require('node:path');
const { cleanString, readRequestJson, safeFileName } = require('./utils.cjs');
const { canonicalPath, isWithin, writeBoundFile } = require('./pathAccess.cjs');

const ZOTERO_API_BASE = 'https://api.zotero.org';

function zoteroHeaders(apiKey) {
  const trimmed = cleanString(apiKey);
  if (!trimmed) throw new Error('Zotero API key cannot be empty');

  return {
    Accept: 'application/json',
    'Zotero-API-Key': trimmed,
    'Zotero-API-Version': '3',
  };
}

function creatorName(creator) {
  if (creator?.name) return cleanString(creator.name);
  return [creator?.firstName, creator?.lastName].map(cleanString).filter(Boolean).join(' ');
}

function creatorSummary(creators) {
  const names = (creators ?? []).map(creatorName).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length <= 2) return names.join(', ');
  return `${names[0]} et al.`;
}

function yearFromDate(date) {
  return cleanString(date).match(/\d{4}/)?.[0] ?? '';
}

function safePdfFilename(input, fallbackKey) {
  const name = safeFileName(input || `${fallbackKey}.pdf`);
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`;
}

async function loadPdfChild(apiKey, userId, itemKey) {
  const response = await fetch(
    `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(itemKey)}/children?format=json&limit=100`,
    { headers: zoteroHeaders(apiKey) },
  );
  const children = await readRequestJson(response, 'Zotero child items');

  return (children ?? []).find((child) =>
    child?.data?.itemType === 'attachment' && child?.data?.contentType === 'application/pdf',
  ) ?? null;
}

async function lookupZoteroKey(apiKey) {
  const trimmed = cleanString(apiKey);
  if (!trimmed) throw new Error('Zotero API key cannot be empty');

  const response = await fetch(`${ZOTERO_API_BASE}/keys/${encodeURIComponent(trimmed)}`, {
    headers: zoteroHeaders(trimmed),
  });
  const data = await readRequestJson(response, 'Zotero key');

  return {
    userId: String(data.userID ?? data.user_id ?? ''),
    username: data.username ?? undefined,
  };
}

async function listZoteroLibraryItems(options) {
  const apiKey = cleanString(options.apiKey);
  const userId = cleanString(options.userId);
  const limit = Math.max(1, Math.min(50, options.limit ?? 20));

  if (!apiKey) throw new Error('Zotero API key cannot be empty');
  if (!userId) throw new Error('Zotero user id cannot be empty');

  const response = await fetch(
    `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items/top?format=json&sort=dateModified&direction=desc&limit=${limit}`,
    { headers: zoteroHeaders(apiKey) },
  );
  const items = await readRequestJson(response, 'Zotero items');
  const output = [];

  for (const item of items ?? []) {
    const itemType = item?.data?.itemType || 'unknown';
    const directAttachment = itemType === 'attachment' && item?.data?.contentType === 'application/pdf' ? item : null;
    const attachment = directAttachment ?? await loadPdfChild(apiKey, userId, item.key);

    output.push({
      itemKey: item.key,
      title: cleanString(item?.data?.title) || 'Untitled',
      creators: creatorSummary(item?.data?.creators),
      year: yearFromDate(item?.data?.date),
      itemType,
      attachmentKey: attachment?.key,
      attachmentTitle: attachment?.data?.title,
      attachmentFilename: attachment?.data?.filename,
      localPdfPath: undefined,
    });
  }

  return output;
}

async function downloadZoteroAttachmentPdf(options, appPaths, authorizeWrite) {
  const apiKey = cleanString(options.apiKey);
  const userId = cleanString(options.userId);
  const attachmentKey = cleanString(options.attachmentKey);

  if (!apiKey) throw new Error('Zotero API key cannot be empty');
  if (!userId) throw new Error('Zotero user id cannot be empty');
  if (!attachmentKey) throw new Error('Zotero attachment key cannot be empty');

  const filename = safePdfFilename(options.filename, attachmentKey);
  const candidate = path.join(appPaths.remotePdfDownloadDir, `${Buffer.from(attachmentKey).toString('base64url')}-${filename}`);
  const outputPath = authorizeWrite ? authorizeWrite(candidate) : canonicalPath(candidate);
  if (!authorizeWrite && !isWithin(canonicalPath(appPaths.dataDir), outputPath)) throw new Error('Download destination escapes library root.');
  const response = await fetch(
    `${ZOTERO_API_BASE}/users/${encodeURIComponent(userId)}/items/${encodeURIComponent(attachmentKey)}/file`,
    { headers: zoteroHeaders(apiKey) },
  );

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Zotero download failed: HTTP ${response.status} ${text}`);
  }

  await writeBoundFile(outputPath, Buffer.from(await response.arrayBuffer()));
  return { path: outputPath, filename };
}

module.exports = {
  creatorSummary,
  lookupZoteroKey,
  listZoteroLibraryItems,
  downloadZoteroAttachmentPdf,
  yearFromDate,
};
