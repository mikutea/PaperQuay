import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createElement } from 'react';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { IncomingSharePanel, type IncomingSharePanelProps } from '../src/components/IncomingSharePanel.tsx';
import { createIncomingShareClient, incomingShareClientMatchesOwner, type IncomingShareDriver, type IncomingShareItem, type IncomingShareNotice } from '../src/platform/incomingShare.ts';
import { isPreparedIncomingShareSource, type PreparedSource } from '../src/library/incomingShare.ts';

const id = (n = 1) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const ownerKey = 'https://account-a.example.test:4311|account-a';
function item(text = 'https://doi.org/10.1000/Example', n = 1): IncomingShareItem {
  return { version: 1, id: id(n), name: `分享-${n}.txt`, kind: 'text', mediaType: 'text/plain',
    sizeBytes: new TextEncoder().encode(text).length, createdAt: 1_793_225_600_000, text };
}
function meta(value: IncomingShareItem) { const { text: _text, ...result } = value; return result; }
function gate<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const content = (node: ReactTestInstance): string => node.children.map(child => typeof child === 'string' ? child : content(child)).join('');
const flush = async () => { await act(async () => { await new Promise<void>(resolve => setImmediate(resolve)); }); };
async function until(condition: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'Incoming share async condition timed out'); await flush(); }
}
async function setup(t: TestContext, options: { sources?: IncomingShareItem[]; driver?: Partial<IncomingShareDriver>; props?: Partial<IncomingSharePanelProps> } = {}) {
  const sources = new Map((options.sources ?? [item()]).map(value => [value.id, value])), originals = structuredClone([...sources.values()]);
  const calls = { listed: 0, read: [] as string[], remove: [] as string[], clear: 0, unsubscribed: 0, reviews: [] as PreparedSource[], busy: [] as boolean[], closed: 0 };
  let notice: IncomingShareNotice | null = null, changed = () => {}, corrupt = false, active = true;
  const driver: IncomingShareDriver = { list: async () => { return corrupt ? { items: [{ text: 'PRIVATE_BAD_BODY' }], notice: 'INVALID' }
    : { items: [...sources.values()].map(meta), notice }; }, read: async ({ id }) => { calls.read.push(id); return structuredClone(sources.get(id)); },
    remove: async ({ id }) => { calls.remove.push(id); sources.delete(id); }, clear: async () => { calls.clear++; sources.clear(); notice = null; corrupt = false; },
    addListener: async (_event, callback) => { changed = callback; return { remove: async () => { calls.unsubscribed++; } }; }, ...options.driver };
  const readList = driver.list; driver.list = async args => { calls.listed++; return readList(args); };
  const inbox = createIncomingShareClient(driver, true, options.props?.ownerKey ?? ownerKey);
  let props: IncomingSharePanelProps = { scopeKey: 'account-a:1', ownerKey, accountCurrent: () => active, inbox,
    onReview: source => { calls.reviews.push(source); }, onClose: () => { calls.closed++; }, onBusyChange: value => calls.busy.push(value), ...options.props };
  let view!: ReactTestRenderer, disposed = false;
  await act(async () => { view = create(createElement(IncomingSharePanel, props)); }); await flush();
  if (props.inbox === inbox && props.accountCurrent() && inbox.available && incomingShareClientMatchesOwner(inbox, props.ownerKey)) {
    await until(() => calls.listed > 0); await flush();
  }
  const buttons = (label: string) => view.root.findAllByType('button').filter(value => content(value) === label);
  const button = (label: string, index = 0) => { const value = buttons(label)[index]; assert.ok(value, `Missing ${label}`); return value; };
  const click = async (label: string, index = 0, settle = true) => {
    await act(async () => { button(label, index).props.onClick(); }); await flush();
    if (settle) await until(() => calls.busy[calls.busy.length - 1] !== true);
  };
  const update = async (next: Partial<IncomingSharePanelProps>) => { props = { ...props, ...next }; await act(async () => { view.update(createElement(IncomingSharePanel, props)); }); await flush(); };
  const emit = async () => { await act(async () => { changed(); }); await flush(); };
  const unmount = async () => { if (!disposed) { disposed = true; await act(async () => { view.unmount(); }); } };
  t.after(unmount);
  return { view, calls, sources, originals, driver, inbox, button, buttons, click, update, emit, unmount, until,
    corrupt: () => { corrupt = true; }, notice: (value: IncomingShareNotice) => { notice = value; }, signOut: () => { active = false; } };
}

test('mount/changed list metadata only; an explicit preview hashes and hands a verified source to current-account review without import/removal', async t => {
  const ui = await setup(t); assert.equal(ui.calls.listed, 1); assert.deepEqual(ui.calls.read, []); assert.equal(ui.calls.reviews.length, 0);
  assert.match(content(ui.view.root), /不会自动导入或联网/); assert.doesNotMatch(content(ui.view.root), /10\.1000\/Example/);
  ui.sources.set(id(2), item('普通正文 PRIVATE_SECOND_BODY', 2)); await ui.emit();
  assert.equal(ui.calls.listed, 2); assert.deepEqual(ui.calls.read, []); assert.doesNotMatch(content(ui.view.root), /PRIVATE_SECOND_BODY/);
  await ui.click('预览此分享');
  assert.deepEqual(ui.calls.read, [id()]); assert.equal(ui.calls.reviews.length, 1); assert.equal(ui.calls.reviews[0].kind, 'doi');
  assert.equal(isPreparedIncomingShareSource(ui.calls.reviews[0]), true); assert.match(content(ui.view.root), /尚未查询题录/);
  assert.deepEqual(ui.calls.remove, []); assert.equal(ui.calls.clear, 0); assert.equal(ui.sources.size, 2);
  assert.equal(ui.view.root.findAllByType('a').length, 0); assert.equal(ui.view.root.findAllByType('img').length, 0);
});

test('unsupported links and multiple DOI sources remain manual, never become a picked DOI or archive', async t => {
  const ui = await setup(t, { sources: [item('https://outside.test/private'), item('10.1000/a\n10.2000/b', 2)] });
  await ui.click('预览此分享'); assert.equal(ui.calls.reviews[0].kind, 'unsupported'); assert.equal(ui.calls.reviews[0].doi, undefined);
  assert.match(content(ui.view.root), /手工核对/); assert.doesNotMatch(content(ui.view.root), /outside\.test/);
  await ui.click('预览此分享', 1); assert.equal(ui.calls.reviews[1].reason, 'MULTIPLE_DOIS'); assert.match(content(ui.view.root), /没有自动选择其中一个/);
  assert.deepEqual(ui.calls.remove, []);
});

test('delete requires confirmation and affects only a pending copy; cancel confirmation is inert', async t => {
  const ui = await setup(t); await ui.click('移除此待处理'); assert.deepEqual(ui.calls.remove, []);
  assert.match(content(ui.view.root), /不删除原文件、原应用内容或账号题录/);
  await ui.click('保留副本'); assert.equal(ui.buttons('确认移除副本').length, 0); assert.deepEqual(ui.calls.remove, []);
  await ui.click('移除此待处理'); await ui.click('确认移除副本');
  assert.deepEqual(ui.calls.remove, [id()]); assert.equal(ui.calls.read.length, 0); assert.equal(ui.sources.size, 0);
  assert.equal(ui.originals[0].text, item().text); assert.match(content(ui.view.root), /原文件和账号题录未删除/);
});

test('bad storage and INVALID notice keep clear-with-confirmation available; successful clear restores an empty inbox', async t => {
  const ui = await setup(t); ui.corrupt(); await ui.emit(); assert.equal(ui.button('清空本机待处理').props.disabled, false);
  assert.match(content(ui.view.root), /分享数据不符合安全格式/); assert.doesNotMatch(content(ui.view.root), /PRIVATE_BAD_BODY/);
  await ui.click('清空本机待处理'); assert.equal(ui.calls.clear, 0); await ui.click('确认移除副本');
  assert.equal(ui.calls.clear, 1); assert.equal(ui.calls.remove.length, 0); assert.match(content(ui.view.root), /已完成当前账号及未分配副本的本机清理/);
  ui.notice('INVALID'); await ui.emit(); assert.match(content(ui.view.root), /损坏数据/); assert.equal(ui.button('清空本机待处理').props.disabled, false);
});

test('read completion and retained old click callbacks cannot cross an account/session replacement', async t => {
  const pending = gate<unknown>(); const ui = await setup(t, { driver: { read: async () => pending.promise } });
  const oldClick = ui.button('预览此分享').props.onClick; await ui.click('预览此分享', 0, false);
  await ui.update({ scopeKey: 'account-b:1' });
  await act(async () => { pending.resolve(item()); }); await flush(); assert.equal(ui.calls.reviews.length, 0);
  await act(async () => { oldClick(); }); await flush(); assert.equal(ui.calls.reviews.length, 0);
  assert.doesNotMatch(content(ui.view.root), /已交给当前账号|单一 DOI 已识别/);
});

test('a source read retired by sign-out or unmount never delivers content or a private error', async t => {
  const pending = gate<unknown>(); const ui = await setup(t, { driver: { read: async () => pending.promise } });
  await ui.click('预览此分享', 0, false); ui.signOut(); await ui.unmount();
  await act(async () => { pending.reject(new Error('file:///private token=PRIVATE_BODY')); }); await flush();
  assert.equal(ui.calls.reviews.length, 0); assert.equal(ui.calls.unsubscribed, 1);
});

test('an inactive account cannot act and busy blocks duplicate preview', async t => {
  const pending = gate<unknown>(); let reads = 0;
  const ui = await setup(t, { driver: { read: async () => { reads++; return pending.promise; } } });
  const click = ui.button('预览此分享').props.onClick;
  await act(async () => { click(); click(); }); assert.equal(reads, 1);
  await ui.update({ scopeKey: 'account-b:2' }); ui.signOut();
  await act(async () => { pending.resolve(item()); }); await flush(); assert.equal(ui.calls.reviews.length, 0);
  await act(async () => { ui.button('清空本机待处理').props.onClick(); }); assert.equal(ui.buttons('确认移除副本').length, 0);
});

test('clear/remove confirmation callbacks and late completions cannot act or announce in the next account', async t => {
  for (const all of [false, true]) {
    const wait = gate<void>(); let mutations = 0;
    const ui = await setup(t, { driver: all ? { clear: async () => { mutations++; await wait.promise; } }
      : { remove: async () => { mutations++; await wait.promise; } } });
    await ui.click(all ? '清空本机待处理' : '移除此待处理');
    const oldConfirm = ui.button('确认移除副本').props.onClick;
    await ui.click('确认移除副本', 0, false); assert.equal(mutations, 1);
    await ui.update({ scopeKey: 'account-b:3' });
    await act(async () => { oldConfirm(); wait.resolve(); }); await flush();
    assert.equal(mutations, 1); assert.doesNotMatch(content(ui.view.root), /已移除此待处理|已完成当前账号及未分配/);
    await ui.unmount();
  }
});

test('read failures stay safe/retryable and close remains possible without account mutations', async t => {
  let fail = true; const ui = await setup(t, { driver: { read: async () => { if (fail) throw new Error('https://private.test?token=PRIVATE'); return item(); } } });
  await ui.click('预览此分享'); assert.match(content(ui.view.root), /读取分享失败/); assert.doesNotMatch(content(ui.view.root), /PRIVATE|private\.test/);
  fail = false; await ui.click('预览此分享'); assert.equal(ui.calls.reviews.length, 1);
  await ui.click('关闭'); assert.equal(ui.calls.closed, 1); assert.equal(ui.calls.remove.length, 0);
});

test('failed clear retires a pending list without leaving refresh permanently disabled', async t => {
  const pending = gate<unknown>();
  const ui = await setup(t, { driver: { list: async () => pending.promise, clear: async () => { throw new Error('PRIVATE_STORAGE_PATH'); } } });
  assert.equal(ui.button('正在读取列表…').props.disabled, true);
  await ui.click('清空本机待处理'); await ui.click('确认移除副本');
  assert.equal(ui.button('刷新待处理分享').props.disabled, false); assert.match(content(ui.view.root), /清空失败/);
  await act(async () => { pending.resolve({ items: [meta(item())], notice: null }); }); await flush();
  assert.doesNotMatch(content(ui.view.root), /分享-1\.txt|PRIVATE_STORAGE_PATH/);
});

test('same-device A claim is invisible to B, cannot be cleared by B, and returns after A relogs in', async t => {
  const value = item(); let claimed: string | null = null, lists = 0;
  const ui = await setup(t, { driver: {
    list: async ({ owner }) => { lists++; return { items: !claimed || claimed === owner ? [meta(value)] : [], notice: null }; },
    read: async ({ owner }) => { if (claimed && claimed !== owner) throw new Error('PRIVATE_OWNER'); claimed = owner; return value; },
    clear: async ({ owner }) => { assert.notEqual(owner, claimed, 'B must not clear A'); },
  } });
  await ui.click('预览此分享'); assert.equal(ui.calls.reviews.length, 1); assert.match(content(ui.view.root), /10\.1000\/example/);
  const keyB = 'https://account-b.example.test|account-b', before = lists;
  // Even an accidentally retained A client fails closed before any B metadata call.
  await ui.update({ ownerKey: keyB, scopeKey: 'account-b:1' });
  assert.equal(lists, before); assert.doesNotMatch(content(ui.view.root), /分享-1\.txt|10\.1000/);
  await ui.update({ inbox: createIncomingShareClient(ui.driver, true, keyB) });
  assert.doesNotMatch(content(ui.view.root), /分享-1\.txt|10\.1000/);
  await ui.click('清空本机待处理'); assert.match(content(ui.view.root), /保留损坏存储原件/); await ui.click('确认移除副本');
  await ui.update({ ownerKey, scopeKey: 'account-a:2', inbox: createIncomingShareClient(ui.driver, true, ownerKey) });
  await ui.until(() => content(ui.view.root).includes('分享-1.txt'));
  assert.match(content(ui.view.root), /分享-1\.txt/); await ui.click('预览此分享'); assert.equal(ui.calls.reviews.length, 2);
});
