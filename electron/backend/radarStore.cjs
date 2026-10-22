const path = require('node:path');
const nativeFs = require('./nativeFs.cjs');
const { hash, normalizeTopic, SOURCES } = require('./radarDomain.cjs');

const MAX_BYTES = 128 * 1024 * 1024;
const string = (value, max = 1000) => typeof value === 'string' && value.length <= max;
const list = (value, max, check) => Array.isArray(value) && value.length <= max && value.every(check);
const stamp = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);
const uniqueIds = (values) => new Set(values.map((item) => item.id)).size === values.length;
function validState(state) {
  if (state?.version !== 1 || !list(state.topics, 20, (topic) => {
    if (!topic || !string(topic.id, 100) || !string(topic.name, 100) || !list(topic.sources, 2, (source) => SOURCES.includes(source)) ||
        !Number.isSafeInteger(topic.revision) || topic.revision < 1 ||
        typeof topic.enabled !== 'boolean' || !['lastAttemptAt', 'lastSuccessAt', 'nextRunAt', 'retryAt'].every((key) => stamp(topic[key])) ||
        !['queries', 'includeTerms', 'excludeTerms', 'priorityTerms', 'methodTerms'].every((key) => list(topic[key], key === 'queries' ? 4 : 30, (term) => string(term, 120)))) return false;
    try { normalizeTopic(topic); } catch { return false; }
    const run = topic.lastRun;
    return run === null || (run && stamp(run.at) && ['success', 'partial', 'failed', 'cancelled'].includes(run.status) &&
      Number.isSafeInteger(run.added) && Number.isSafeInteger(run.known) && typeof run.capacity === 'boolean' &&
      list(run.reports, 8, (report) => report && SOURCES.includes(report.source) && string(report.query, 120) &&
        Number.isFinite(report.received) && Number.isFinite(report.total) && typeof report.limited === 'boolean' &&
        (report.error === null || string(report.error, 200)) && (report.retryAt === undefined || stamp(report.retryAt))));
  }) || !uniqueIds(state.topics)) return false;
  const topicIds = new Set(state.topics.map((topic) => topic.id));
  return list(state.candidates, 5000, (item) => item && string(item.id, 100) && string(item.title) &&
    list(item.authors, 100, (author) => string(author, 200)) && string(item.year, 4) && string(item.doi, 500) &&
    string(item.publication, 500) && string(item.url, 2000) && string(item.abstractText, 12000) &&
    list(item.keywords, 30, (word) => string(word, 120)) && list(item.topicIds, 20, (id) => topicIds.has(id)) &&
    list(item.sources, 2, (source) => SOURCES.includes(source)) && stamp(item.discoveredAt) && stamp(item.lastSeenAt) &&
    typeof item.dismissed === 'boolean' && (item.paperId === null || string(item.paperId, 200))) && uniqueIds(state.candidates) &&
    list(state.queue, 50000, (item) => item && string(item.paperId, 200) &&
      (item.status === undefined || ['unread', 'later', 'read'].includes(item.status)) &&
      (item.pinned === undefined || typeof item.pinned === 'boolean'));
}

function createRadarStore(appPaths) {
  // Scheduling and reading choices are private to this profile AND library.
  // Opening a supplied library can never activate its embedded subscriptions.
  const filePath = path.join(path.dirname(appPaths.configPath), 'radar', `${hash(appPaths.dataDir)}.json`);
  const empty = () => ({ version: 1, topics: [], candidates: [], queue: [] });
  function load() {
    let state;
    try { state = JSON.parse(nativeFs.readSync(filePath, { singleLink: true, maxBytes: MAX_BYTES }).bytes.toString('utf8')); }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw new Error('Radar data could not be read; the original file has been preserved.'); }
    if (!validState(state)) throw new Error('Unsupported radar data; the original file has been preserved.');
    return state;
  }
  function update(mutator) {
    const state = load();
    const result = mutator(state);
    if (!validState(state)) throw new Error('Invalid radar change; existing data has been preserved.');
    const bytes = Buffer.from(JSON.stringify(state));
    if (bytes.length > MAX_BYTES) throw new Error('Radar data is full; existing data has been preserved.');
    nativeFs.mkdirSync(path.dirname(filePath));
    nativeFs.writeSync(filePath, bytes);
    return result;
  }
  return { load, update, filePath };
}

module.exports = { createRadarStore };
