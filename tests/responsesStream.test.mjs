import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readOpenAiStreamResponse, pickChatText } = require('../electron/backend/utils.cjs');
const delta = (text, outputIndex = 1, contentIndex = 0) => ({
  type: 'response.output_text.delta', output_index: outputIndex, content_index: contentIndex, delta: text,
});
const done = (text, outputIndex = 1, contentIndex = 0) => ({
  type: 'response.output_text.done', output_index: outputIndex, content_index: contentIndex, text,
});
const completed = text => ({ type: 'response.completed', response: {
  object: 'response', status: 'completed',
  output: text ? [{ type: 'message', content: [{ type: 'output_text', text }] }] : [],
} });

async function read(events) {
  const deltas = [];
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  const result = await readOpenAiStreamResponse(response, { apiMode: 'responses' }, {
    onTextDelta(text) { deltas.push(text); },
  });
  return { result, text: pickChatText(result, 'responses'), streamed: deltas.join('') };
}

test('Responses delta, text done and completed snapshots produce one final answer', async () => {
  const result = await read([delta('40'), delta('次'), done('40次'), completed('40次')]);
  assert.equal(result.streamed, '40次');
  assert.equal(result.text, '40次');
});

test('a finalized text part replaces its deltas when the completed response is absent', async () => {
  const result = await read([delta('40'), delta('次'), done('40次')]);
  assert.equal(result.streamed, '40次');
  assert.equal(result.text, '40次');
});

test('a done-only text part remains available without simulating streamed deltas', async () => {
  const result = await read([done('Final answer')]);
  assert.equal(result.streamed, '');
  assert.equal(result.text, 'Final answer');
});

test('the completed response is authoritative over earlier partial text', async () => {
  const result = await read([delta('Partial'), done('Partial'), completed('Final answer')]);
  assert.equal(result.streamed, 'Partial');
  assert.equal(result.text, 'Final answer');
  const empty = await read([delta('Partial'), done('Partial'), completed('')]);
  assert.equal(empty.text, '');
  assert.deepEqual(empty.result.output, []);
});

test('indexed text parts retain their order and intentional repeated tokens', async () => {
  const result = await read([
    delta('哈', 0, 0), delta('B', 1, 0), delta('哈', 0, 0),
    done('哈哈', 0, 0), done('B', 1, 0), done('A', 0, 1),
  ]);
  assert.equal(result.streamed, '哈B哈');
  assert.equal(result.text, '哈哈AB');
});
