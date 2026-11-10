import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { act, create } from 'react-test-renderer';

const require = createRequire(import.meta.url);
const stubs = {
  '../../services/libraryAgent': `
    export const applyLibraryAgentPlan = async () => { throw new Error('Unexpected write'); };
    export const loadLibraryAgentAvailableModelPresets = async () => [{ id: 'test-model', model: 'test' }];
    export const loadLibraryAgentModelPresetById = async () => ({ id: 'test-model', model: 'test' });
    export const runConversationalLibraryAgent = args => globalThis.agentStreamFixture.run(args);
  `,
  '../../services/library': `
    export const listLibraryCategories = async () => [];
    export const listAllLibraryPapers = async () => [];
  `,
  './AgentWorkspaceView': `
    import { createElement } from 'react';
    export default props => createElement('agent-view', props);
  `,
  '../reader/documentReaderShared': `
    export const buildAttachmentFromPath = () => { throw new Error('Unexpected attachment'); };
    export const buildScreenshotAttachmentFromPath = buildAttachmentFromPath;
  `,
  '../../services/desktop': `
    export const captureSystemScreenshot = () => { throw new Error('Unexpected capture'); };
    export const selectChatAttachmentPaths = captureSystemScreenshot;
  `,
};
let AgentWorkspace;
test.before(async () => {
  const result = await build({
    entryPoints: ['src/features/agent/AgentWorkspace.tsx'],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
    external: ['react', 'react/jsx-runtime'], logLevel: 'silent',
    plugins: [{ name: 'agent-boundaries', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path)
        ? { path: args.path, namespace: 'agent-boundary' } : undefined);
      builder.onLoad({ filter: /.*/, namespace: 'agent-boundary' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports);
  AgentWorkspace = module.exports.default;
});

for (const outcome of ['answer', 'choice', 'error']) {
  test(`streamed ${outcome} keeps its terminal message and saved history`, async t => {
    const previousWindow = globalThis.window;
    const values = new Map(), timers = new Map();
    let nextTimer = 0, root;
    globalThis.window = {
      localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
      setTimeout: callback => { const id = ++nextTimer; timers.set(id, callback); return id; },
      clearTimeout: id => timers.delete(id),
    };
    globalThis.agentStreamFixture = { run: async ({ streamHandlers }) => {
      streamHandlers.onDelta('partial', 'partial response');
      streamHandlers.onDelta(' pending', 'partial response pending');
      if (outcome === 'error') throw new Error('Connection interrupted');
      return {
        kind: outcome, answer: 'Final formatted answer', contextLabel: 'Direct answer',
        thinking: 'Final reasoning', citations: [],
        ...(outcome === 'choice' ? { choices: [{ id: 'next', label: 'Continue', instruction: 'Continue' }] } : {}),
      };
    } };
    t.after(async () => {
      if (root) await act(async () => root.unmount());
      globalThis.window = previousWindow;
      delete globalThis.agentStreamFixture;
    });
    await act(async () => { root = create(createElement(AgentWorkspace)); });
    const view = () => root.root.findByType('agent-view').props;
    assert.equal(view().loading, false);
    await act(async () => { view().onSubmitPrompt('Ordinary question'); });
    const message = view().messages.at(-1);
    assert.equal(view().activeSessionRunning, false);
    assert.equal(timers.size, 0, 'No pending stream update can overwrite the terminal result');
    if (outcome === 'error') {
      assert.equal(message.error, 'Connection interrupted');
      assert.match(message.content, /Connection interrupted/);
      assert.match(message.meta, /^error/);
    } else {
      assert.equal(message.content, 'Final formatted answer');
      assert.equal(message.thinking, 'Final reasoning');
      assert.match(message.meta, outcome === 'choice' ? /^waiting for choice/ : /^Direct answer/);
      if (outcome === 'choice') assert.equal(message.choices.length, 1);
    }
    const history = JSON.parse(values.get('paperquay-agent-history-v1'));
    assert.deepEqual(history[0].messages.at(-1), JSON.parse(JSON.stringify(message)), 'Saved history retains the terminal result');
  });
}
