import type { RadarTopicConfig } from '../../types/radar';

export const newTopicConfig = (): RadarTopicConfig => ({
  name: '', queries: [], includeTerms: [], excludeTerms: [], priorityTerms: [], methodTerms: [],
  sources: ['crossref', 'openalex'], lookbackDays: 90, intervalHours: 24, enabled: false,
  weights: { relevance: 40, priority: 30, methods: 20, recency: 10 },
});

export function topicConfigOnly(topic: RadarTopicConfig): RadarTopicConfig {
  return { name: topic.name, queries: topic.queries, includeTerms: topic.includeTerms, excludeTerms: topic.excludeTerms,
    priorityTerms: topic.priorityTerms, methodTerms: topic.methodTerms, sources: topic.sources,
    lookbackDays: topic.lookbackDays, intervalHours: topic.intervalHours, weights: { ...topic.weights }, enabled: false };
}

export function parseTopicConfig(raw: string): RadarTopicConfig {
  if (raw.length > 16384) throw new Error('Configuration must be smaller than 16 KB.');
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid topic configuration.');
  const data = value as Record<string, unknown>;
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 100) throw new Error('Invalid topic name.');
  for (const key of ['queries', 'includeTerms', 'excludeTerms', 'priorityTerms', 'methodTerms', 'sources']) {
    if (!Array.isArray(data[key]) || (data[key] as unknown[]).length > (key === 'queries' ? 4 : key === 'sources' ? 2 : 30) || !(data[key] as unknown[]).every((item) => typeof item === 'string' && item.length <= 120)) throw new Error(`Invalid list: ${key}`);
  }
  if (!(data.queries as string[]).some((item) => item.trim()) || !(data.sources as string[]).length) throw new Error('A query and source are required.');
  if (!data.weights || typeof data.weights !== 'object') throw new Error('Invalid ranking weights.');
  for (const key of ['relevance', 'priority', 'methods', 'recency']) {
    const weight = (data.weights as Record<string, unknown>)[key];
    if (!Number.isInteger(weight) || Number(weight) < 0 || Number(weight) > 100) throw new Error('Invalid ranking weights.');
  }
  if (!['relevance', 'priority', 'methods', 'recency'].some((key) => Number((data.weights as Record<string, unknown>)[key]) > 0)) throw new Error('At least one weight must be greater than zero.');
  if (!Number.isInteger(data.lookbackDays) || Number(data.lookbackDays) < 7 || Number(data.lookbackDays) > 3650 ||
      ![6, 12, 24, 168].includes(Number(data.intervalHours)) ||
      !(data.sources as string[]).every((source) => ['crossref', 'openalex'].includes(source))) throw new Error('Invalid source or schedule.');
  // Import only configuration, never identity, history, credentials or enabled schedules.
  return topicConfigOnly(data as unknown as RadarTopicConfig);
}
