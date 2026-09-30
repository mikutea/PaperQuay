import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createAiCommands } = require('../electron/backend/aiCommands.cjs');

async function stream(chunks: string[], apiMode = 'chat_completions') {
  const previousFetch = globalThis.fetch;
  const events: { requestId: string; kind: string; text?: string }[] = [];
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
  try {
    await createAiCommands({ ragStore: {} }).ask_document_openai_compatible_stream({
      requestId: 'qa-test',
      options: { baseUrl: 'http://127.0.0.1:1234/v1', apiKey: 'fixture', model: 'fixture', apiMode, title: 'Fixture', messages: [] },
    }, { sender: { send(_channel: string, _event: string, payload: typeof events[number]) { events.push(payload); } } });
    return events;
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('QA forwards provider reasoning separately and flushes fragmented final SSE data', async () => {
  const events = await stream([
    'data: {"choices":[{"delta":{"reasoning_content":"Checking evidence"}}]}\n\n',
    'data: {"choices":[{"del',
    'ta":{"content":"**Answer**"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":" complete"}}]}',
  ]);
  assert.deepEqual(events.map(({ kind, text }) => ({ kind, text })), [
    { kind: 'thinking', text: 'Checking evidence' },
    { kind: 'delta', text: '**Answer**' },
    { kind: 'delta', text: ' complete' },
    { kind: 'done', text: undefined },
  ]);
  assert.ok(events.every((event) => event.requestId === 'qa-test'));
});

test('QA supports Responses public reasoning summaries and answer deltas', async () => {
  const events = await stream([
    'data: {"type":"response.reasoning_summary_text.delta","delta":"Summary"}\n\n',
    'data: {"type":"response.output_text.delta","delta":"Answer"}\n\n',
    'data: [DONE]\n\n',
  ], 'responses');
  assert.deepEqual(events.map((event) => event.kind), ['thinking', 'delta', 'done']);
});

test('QA rejects malformed and provider-error streams instead of silently finishing', async () => {
  await assert.rejects(stream(['data: {broken}\n\n']), /invalid SSE JSON/);
  await assert.rejects(stream(['data: {"error":{"message":"fixture failure"}}\n\n']), /fixture failure/);
  await assert.rejects(stream(['data: [DONE]\n\n']), /empty SSE/);
});
