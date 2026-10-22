const { DAY_MS, normalizeDoi, publicUrl, text } = require('./radarDomain.cjs');
const { setTimeout: delay } = require('node:timers/promises');

const PAGE_SIZE = 25;
const MAX_PAGES = 2;
const MAX_BYTES = 3 * 1024 * 1024;

function plainAbstract(value) {
  return text(typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ') : '', 12000);
}

function openAlexAbstract(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const words = [];
  for (const [word, positions] of Object.entries(value).slice(0, 4000)) {
    for (const position of (Array.isArray(positions) ? positions : []).slice(0, 100)) {
      if (Number.isInteger(position) && position >= 0 && position < 4000) words[position] = text(word, 100);
    }
  }
  return text(words.join(' '), 12000);
}

function mapWork(source, item) {
  if (!item || typeof item !== 'object') return null;
  const doi = normalizeDoi(source === 'openalex' ? item.doi : item.DOI);
  const title = text(source === 'openalex' ? item.title || item.display_name : Array.isArray(item.title) ? item.title[0] : '', 1000);
  if (!title) return null;
  const year = source === 'openalex' ? item.publication_year :
    (item.published?.['date-parts']?.[0]?.[0] || item['published-online']?.['date-parts']?.[0]?.[0] || item.issued?.['date-parts']?.[0]?.[0]);
  const authors = source === 'openalex'
    ? (Array.isArray(item.authorships) ? item.authorships : []).slice(0, 100).map((a) => text(a?.author?.display_name, 200)).filter(Boolean)
    : (Array.isArray(item.author) ? item.author : []).slice(0, 100).map((a) => text(a?.name || `${a?.given || ''} ${a?.family || ''}`, 200)).filter(Boolean);
  const sourceId = text(source === 'openalex' ? item.id : doi, 500);
  if (!sourceId) return null;
  return { source, sourceId, title, doi, authors,
    year: Number.isInteger(Number(year)) && Number(year) >= 1800 && Number(year) < 2200 ? String(year) : '',
    publication: text(source === 'openalex' ? item.primary_location?.source?.display_name : item['container-title']?.[0], 500),
    url: doi ? `https://doi.org/${doi}` : publicUrl(source === 'openalex' ? item.primary_location?.landing_page_url || item.id : item.URL),
    abstractText: source === 'openalex' ? openAlexAbstract(item.abstract_inverted_index) : plainAbstract(item.abstract),
    keywords: [],
  };
}

async function readBoundedJson(response) {
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    if ([429, 503].includes(response.status)) {
      const header = response.headers.get('retry-after');
      const milliseconds = header && /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header || '') - Date.now();
      error.retryAt = Date.now() + Math.min(DAY_MS, Math.max(60000, Number.isFinite(milliseconds) ? milliseconds : 3600000));
    }
    await response.body?.cancel().catch(() => {});
    throw error;
  }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error('Response too large');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error('Response too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

async function searchTopic(topic, settings = {}, { signal, fetchImpl = fetch, timestamp = Date.now(), throttleMs = 500 } = {}) {
  const records = [], reports = [];
  const from = new Date(timestamp - topic.lookbackDays * DAY_MS).toISOString().slice(0, 10);
  const until = new Date(timestamp).toISOString().slice(0, 10);
  let requests = 0;
  for (const source of topic.sources) {
    let stopProvider = false;
    for (const query of topic.queries) {
      if (signal?.aborted) throw signal.reason || new Error('Cancelled');
      let received = 0, total = 0;
      try {
        for (let page = 1; page <= MAX_PAGES; page++) {
          if (requests++ && throttleMs) await delay(throttleMs, undefined, { signal });
          const url = new URL(source === 'openalex' ? 'https://api.openalex.org/works' : 'https://api.crossref.org/works');
          if (source === 'openalex') {
            url.searchParams.set('search', query);
            url.searchParams.set('filter', `from_publication_date:${from},to_publication_date:${until}`);
            url.searchParams.set('sort', 'publication_date:desc');
            url.searchParams.set('per_page', String(PAGE_SIZE));
            url.searchParams.set('page', String(page));
            if (settings.openAlexApiKey) url.searchParams.set('api_key', settings.openAlexApiKey);
            if (settings.openAlexMailto) url.searchParams.set('mailto', settings.openAlexMailto);
          } else {
            url.searchParams.set('query.bibliographic', query);
            url.searchParams.set('filter', `from-pub-date:${from},until-pub-date:${until}`);
            url.searchParams.set('sort', 'published');
            url.searchParams.set('order', 'desc');
            url.searchParams.set('rows', String(PAGE_SIZE));
            url.searchParams.set('offset', String((page - 1) * PAGE_SIZE));
          }
          // Only fixed provider hosts are fetched; refuse redirects, including
          // redirects that could disclose the optional OpenAlex credential.
          const timeout = AbortSignal.timeout(15000);
          const response = await fetchImpl(url, { redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            headers: { Accept: 'application/json', 'User-Agent': 'PaperQuay-LiteratureRadar/1.0' } });
          const data = await readBoundedJson(response);
          const items = source === 'openalex' ? data.results : data.message?.items;
          if (!Array.isArray(items)) throw new Error('Invalid response');
          const reportedTotal = Number(source === 'openalex' ? data.meta?.count : data.message?.['total-results']);
          total = Number.isSafeInteger(reportedTotal) && reportedTotal >= 0 ? reportedTotal : items.length;
          received += Math.min(items.length, PAGE_SIZE);
          records.push(...items.slice(0, PAGE_SIZE).map((item) => mapWork(source, item)).filter(Boolean));
          if (items.length < PAGE_SIZE || received >= total) break;
        }
        reports.push({ source, query, received, total, limited: total > received, error: null });
      } catch (error) {
        if (signal?.aborted) throw signal.reason || new Error('Cancelled');
        // Never return request URLs, provider response bodies, or API keys.
        const message = /^HTTP \d{3}$|^Response too large$|^Invalid response$/.test(error?.message || '') ? error.message : 'Request failed or timed out';
        reports.push({ source, query, received, total, limited: false, error: message, retryAt: error?.retryAt || null });
        stopProvider = [401, 403, 429, 503].includes(error?.status);
      }
      // Rate limits/auth failures stop this provider for the whole run.
      if (stopProvider) break;
    }
  }
  return { records, reports };
}

module.exports = { mapWork, readBoundedJson, searchTopic, PAGE_SIZE, MAX_PAGES };
