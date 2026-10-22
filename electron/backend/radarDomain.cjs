const { createHash, randomUUID } = require('node:crypto');

const DAY_MS = 86400000;
const DEFAULT_WEIGHTS = Object.freeze({ relevance: 40, priority: 30, methods: 20, recency: 10 });
const SOURCES = ['crossref', 'openalex'];
const text = (value, max = 1000) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const comparable = (value) => text(value, 12000).normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const hash = (value) => createHash('sha256').update(value).digest('hex').slice(0, 24);

function normalizeDoi(value) {
  const normalized = text(value, 500).replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase();
  return /^10\.\d{4,9}\/[^\s<>]+$/.test(normalized) ? normalized : '';
}

function publicUrl(value) {
  try {
    const url = new URL(text(value, 2000));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    const host = url.hostname.toLowerCase();
    if (!host.includes('.') || host.endsWith('.local') || host.endsWith('.localhost') ||
        host === 'localhost' || host.startsWith('[') || /^\d+(?:\.\d+){3}$/.test(host)) return '';
    return url.href;
  } catch { return ''; }
}

function terms(value, max = 30) {
  if (!Array.isArray(value)) throw new Error('Terms must be a list.');
  const values = [...new Set(value.map((item) => text(item, 120)).filter(Boolean))];
  if (values.length > max) throw new Error(`Use at most ${max} terms.`);
  return values;
}

function normalizeTopic(input, previous) {
  if (!input || typeof input !== 'object') throw new Error('A topic is required.');
  const name = text(input.name, 100);
  const queries = terms(input.queries, 4);
  if (!name || !queries.length) throw new Error('Enter a topic name and at least one search query.');
  const sources = [...new Set(Array.isArray(input.sources) ? input.sources : [])].filter((source) => SOURCES.includes(source));
  if (!sources.length) throw new Error('Select at least one metadata source.');
  const lookbackDays = Number(input.lookbackDays ?? 90);
  const intervalHours = Number(input.intervalHours ?? 24);
  if (!Number.isInteger(lookbackDays) || lookbackDays < 7 || lookbackDays > 3650) throw new Error('Search window must be 7–3650 days.');
  if (![6, 12, 24, 168].includes(intervalHours)) throw new Error('Choose a supported check interval.');
  const weights = {};
  for (const key of Object.keys(DEFAULT_WEIGHTS)) {
    const value = Number(input.weights?.[key] ?? DEFAULT_WEIGHTS[key]);
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error('Weights must be integers from 0 to 100.');
    weights[key] = value;
  }
  if (!Object.values(weights).some(Boolean)) throw new Error('At least one ranking weight must be greater than zero.');
  const sourcesChanged = previous && JSON.stringify([...sources].sort()) !== JSON.stringify([...previous.sources].sort());
  const queriesChanged = previous && JSON.stringify(queries) !== JSON.stringify(previous.queries);
  // A provider cooldown still applies when only its query changes. Removing
  // that provider must not block the remaining sources or retain its due time.
  const retryAt = sourcesChanged ? Math.max(0, ...(previous.lastRun?.reports || [])
    .filter((report) => sources.includes(report.source)).map((report) => report.retryAt || 0)) : previous?.retryAt ?? null;
  const nextRunAt = sourcesChanged || queriesChanged ? retryAt || null :
    previous?.intervalHours === intervalHours ? previous.nextRunAt :
      previous?.lastAttemptAt ? Math.max(previous.lastAttemptAt + intervalHours * 3600000, retryAt || 0) : null;
  return {
    id: previous?.id || `topic-${randomUUID()}`, revision: (previous?.revision || 0) + 1,
    name, queries, sources, lookbackDays, intervalHours, enabled: input.enabled === true,
    includeTerms: terms(input.includeTerms ?? []), excludeTerms: terms(input.excludeTerms ?? []),
    priorityTerms: terms(input.priorityTerms ?? []), methodTerms: terms(input.methodTerms ?? []), weights,
    lastAttemptAt: previous?.lastAttemptAt ?? null, lastSuccessAt: previous?.lastSuccessAt ?? null,
    nextRunAt,
    lastRun: previous?.lastRun ?? null,
    retryAt,
  };
}

function paperIdentity(paper) {
  const doi = normalizeDoi(paper.doi);
  const author = comparable(typeof paper.authors?.[0] === 'string' ? paper.authors[0] : paper.authors?.[0]?.name);
  const title = comparable(paper.title), year = text(String(paper.year ?? ''), 4);
  return { doi, author, title, year };
}

function samePaper(left, right) {
  const a = paperIdentity(left), b = paperIdentity(right);
  if (a.doi && b.doi) return a.doi === b.doi;
  // Never collapse two known DOIs, or rely on an ambiguous title alone.
  return Boolean(a.title && a.title === b.title && a.year && a.year === b.year && a.author && a.author === b.author);
}

function candidateKey(paper) {
  const p = paperIdentity(paper);
  return `candidate-${hash(p.doi ? `doi:${p.doi}` : `${p.title}|${p.year}|${p.author}|${!p.author || !p.year ? paper.sourceId : ''}`)}`;
}

const candidatePaperId = (candidateId) => `paper-radar-${hash(candidateId)}`;

// Avoid repeatedly normalizing every library title for every candidate. A
// fallback match still requires title, year and first author and never merges
// two distinct known DOIs.
function createPaperIndex(papers) {
  const byId = new Map(), byDoi = new Map(), byMetadata = new Map();
  const metadataKey = (p) => p.title && p.year && p.author ? JSON.stringify([p.title, p.year, p.author]) : null;
  function add(paper) {
    const identity = paperIdentity(paper), key = metadataKey(identity);
    byId.set(paper.id, paper);
    if (identity.doi && !byDoi.has(identity.doi)) byDoi.set(identity.doi, paper);
    if (key) {
      if (!byMetadata.has(key)) byMetadata.set(key, []);
      if (!byMetadata.get(key).includes(paper)) byMetadata.get(key).push(paper);
    }
  }
  for (const paper of papers) add(paper);
  return { add, byId, find(paper) {
    const identity = paperIdentity(paper);
    if (identity.doi && byDoi.has(identity.doi)) return byDoi.get(identity.doi);
    return byMetadata.get(metadataKey(identity))?.find((item) => !identity.doi || !normalizeDoi(item.doi));
  } };
}

function searchable(paper) {
  return text([paper.title, paper.abstractText, ...(paper.keywords || []), ...(paper.tags || []).map((tag) => tag.name || tag)].join(' '), 20000).normalize('NFKC').toLocaleLowerCase();
}

function matchesTerm(haystack, term) {
  const needle = text(term, 120).normalize('NFKC').toLocaleLowerCase();
  if (!needle) return false;
  if (/^[a-z0-9]+$/i.test(needle)) return new RegExp(`(?:^|[^a-z0-9])${needle}(?:$|[^a-z0-9])`, 'i').test(haystack);
  return haystack.includes(needle);
}

function topicAccepts(paper, topic) {
  const haystack = searchable(paper);
  return !topic.excludeTerms.some((term) => matchesTerm(haystack, term)) &&
    (!topic.includeTerms.length || topic.includeTerms.some((term) => matchesTerm(haystack, term)));
}

function rankPaper(paper, topic, timestamp = Date.now()) {
  const haystack = searchable(paper);
  const reasons = [];
  const scoreTerms = (key, values) => {
    const matched = values.filter((term) => matchesTerm(haystack, term));
    const points = values.length ? Math.round(topic.weights[key] * matched.length / values.length) : 0;
    reasons.push({ key, points, max: topic.weights[key], matched });
    return points;
  };
  const relevantTerms = topic.includeTerms.length ? topic.includeTerms : topic.queries;
  let score = scoreTerms('relevance', relevantTerms) + scoreTerms('priority', topic.priorityTerms) + scoreTerms('methods', topic.methodTerms);
  const year = Number(paper.year), currentYear = new Date(timestamp).getUTCFullYear();
  const recency = Number.isInteger(year) && year >= 1800 && year <= currentYear + 1
    ? Math.round(topic.weights.recency * Math.max(0, 1 - Math.max(0, currentYear - year) / 10)) : 0;
  reasons.push({ key: 'recency', points: recency, max: topic.weights.recency, matched: recency ? [String(year)] : [] });
  score += recency;
  const excluded = !topicAccepts(paper, topic);
  return { score: excluded ? 0 : score, reasons, excluded };
}

function buildQueue(library, state, topicId, timestamp = Date.now()) {
  const topic = state.topics.find((item) => item.id === topicId) || state.topics[0];
  if (!topic) return [];
  const overrides = new Map(state.queue.map((item) => [item.paperId, item]));
  return library.papers.map((paper) => {
    const preference = overrides.get(paper.id);
    // Reader position/heatmap and the legacy readingProgress field are not an
    // explicit completion decision. Keep Read/Later under the reader's control.
    const status = preference?.status || 'unread';
    const availablePdf = (paper.attachments || []).some((item) => item.kind === 'pdf' && !item.missing);
    return { paper, ...rankPaper(paper, topic, timestamp), status, pinned: preference?.pinned === true,
      evidence: availablePdf ? 'pdf-available' : paper.abstractText ? 'abstract' : 'metadata' };
  }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.score - a.score ||
    a.paper.importedAt - b.paper.importedAt || a.paper.id.localeCompare(b.paper.id));
}

function mergeCandidates(state, records, topic, timestamp, library) {
  let added = 0, known = 0, capacity = false;
  const candidates = createPaperIndex(state.candidates), papers = createPaperIndex(library.papers);
  for (const record of records) {
    if (!topicAccepts(record, topic)) continue;
    const existing = candidates.find(record) || candidates.byId.get(candidateKey(record));
    const linked = papers.find(record);
    if (existing) {
      existing.topicIds = [...new Set([...existing.topicIds, topic.id])];
      existing.sources = [...new Set([...existing.sources, record.source])];
      existing.lastSeenAt = timestamp;
      for (const key of ['doi', 'year', 'publication', 'url', 'abstractText']) {
        if (!existing[key] && record[key]) existing[key] = record[key];
      }
      if (!existing.authors.length && record.authors.length) existing.authors = record.authors;
      if (!existing.keywords?.length && record.keywords?.length) existing.keywords = record.keywords;
      candidates.add(existing);
      if (linked) existing.paperId = linked.id;
      known++;
    } else if (state.candidates.length < 5000) {
      state.candidates.push({ ...record, id: candidateKey(record), topicIds: [topic.id], sources: [record.source],
        discoveredAt: timestamp, lastSeenAt: timestamp, dismissed: false, paperId: linked?.id || null });
      candidates.add(state.candidates.at(-1));
      if (linked) known++; else added++;
    } else capacity = true;
  }
  return { added, known, capacity };
}

module.exports = { DAY_MS, DEFAULT_WEIGHTS, SOURCES, text, comparable, normalizeDoi, publicUrl, normalizeTopic,
  candidateKey, candidatePaperId, samePaper, createPaperIndex, topicAccepts, rankPaper, buildQueue, mergeCandidates, hash };
