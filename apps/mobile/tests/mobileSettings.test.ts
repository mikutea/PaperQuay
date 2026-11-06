import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MobileSettings, type AccountSettingsPage, type SettingsActions } from '../src/components/MobileSettings.tsx';

test('settings home shows destinations without mounting detailed forms or running their actions', async () => {
  const calls: string[] = [];
  const actions: SettingsActions = Object.fromEntries(['cloud', 'remote', 'capabilities', 'agent', 'graph', 'zotero', 'incoming', 'export', 'research', 'review'].map(key => [key, () => { calls.push(key); }])) as unknown as SettingsActions;
  const rendered: AccountSettingsPage[] = [];
  let root!: ReactTestRenderer;
  const click = async (label: string) => { await act(async () => {
    const row = root.root.findAllByType('button').find(node => node.props['aria-label'] === label || node.children.includes(label));
    assert.ok(row, label); row.props.onClick();
  }); };
  try {
    await act(async () => { root = create(createElement(MobileSettings, {
      accountStatus: '账号与设备', syncStatus: '已同步', actions,
      renderAccount: page => { rendered.push(page); return createElement('p', null, page); },
      renderAi: onBack => createElement('button', { onClick: onBack }, '返回设置'),
    })); });
    assert.equal(root.root.findAllByType('input').length, 0);
    assert.equal(root.root.findAllByType('button').length, 6);
    assert.deepEqual(calls, []); assert.deepEqual(rendered, []);
    await click('同步与存储'); assert.equal(rendered.at(-1), 'sync');
    await click('云端 PDF'); assert.deepEqual(calls, ['cloud']);
    await click('本机存储'); assert.equal(rendered.at(-1), 'storage');
    await click('同步与存储'); assert.equal(rendered.at(-1), 'sync');
    await click('设置');
    await click('导入与导出'); await click('连接 Zotero'); await click('导出笔记与引用');
    assert.deepEqual(calls, ['cloud', 'zotero', 'export']);
    await click('设置'); await click('阅读工具'); await click('多篇文献问答'); await click('用电脑处理文献');
    assert.deepEqual(calls, ['cloud', 'zotero', 'export', 'research', 'remote']);
    await click('设置'); await click('AI 助手'); await click('返回设置');
    assert.equal(root.root.findAllByProps({ 'data-settings-page': 'home' }).length, 1);
    await click('我的 PaperQuay'); assert.equal(rendered.at(-1), 'account');
  } finally { if (root) await act(async () => root.unmount()); }
});

test('a contextual AI setup request opens the same settings page once and returns to the home list', async () => {
  let consumed = 0, root!: ReactTestRenderer;
  const props = { accountStatus: '账号与设备', syncStatus: '等待首次同步', actions: { capabilities() {} },
    renderAccount: () => null, renderAi: (back: () => void) => createElement('button', { onClick: back }, '返回设置'),
    onAiOpened: () => { consumed++; } };
  try {
    await act(async () => { root = create(createElement(MobileSettings, { ...props, openAi: true })); });
    assert.equal(consumed, 1);
    assert.equal(root.root.findAllByProps({ 'data-settings-page': 'ai' }).length, 1);
    await act(async () => root.update(createElement(MobileSettings, { ...props, openAi: false })));
    act(() => root.root.findByType('button').props.onClick());
    assert.equal(root.root.findAllByProps({ 'data-settings-page': 'home' }).length, 1);
    assert.equal(consumed, 1);
  } finally { if (root) await act(async () => root.unmount()); }
});
