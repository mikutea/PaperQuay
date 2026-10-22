import test from 'node:test';
import assert from 'node:assert/strict';
import { newTopicConfig, parseTopicConfig, topicConfigOnly } from '../src/features/radar/topicConfig.ts';

test('shared topic JSON carries configuration without identity, schedule activation, history or keys', () => {
  const input = { ...newTopicConfig(), name: 'Coastal resilience', queries: ['coastal flooding'], enabled: true,
    id: 'supplied-id', lastRun: { status: 'success' }, openAlexApiKey: 'secret' };
  const result = parseTopicConfig(JSON.stringify(input));
  assert.equal(result.enabled, false);
  assert.equal('id' in result, false); assert.equal('lastRun' in result, false); assert.equal('openAlexApiKey' in result, false);
  assert.equal(topicConfigOnly(input).enabled, false);
});

test('import rejects empty, unbounded and invalid research configurations before loading the form', () => {
  const valid = { ...newTopicConfig(), name: 'Example', queries: ['coastal flooding'] };
  for (const patch of [{ queries: [] }, { sources: [] }, { sources: ['untrusted'] }, { name: '' },
    { queries: Array(5).fill('query') }, { intervalHours: 1 }, { weights: { relevance: 0, priority: 0, methods: 0, recency: 0 } }]) {
    assert.throws(() => parseTopicConfig(JSON.stringify({ ...valid, ...patch })));
  }
  assert.throws(() => parseTopicConfig(' '.repeat(16385)));
});
