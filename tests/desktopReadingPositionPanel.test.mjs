import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { createElement } from 'react';
import { createReadingFixture, createReadingTrackingFixture, deferred, readingConflict, readingData, readingDraft, readingId, readingOwn, readingPending, readingPosition, readingPreview, readingScope, readingSnapshot, readingSource, readingStatus } from './fixtures/desktopReadingPosition.mjs';
const require = createRequire(import.meta.url);
async function load(entry) { const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent' }); const module = { exports: {} }; new Function('require', 'module', 'exports', result.outputFiles[0].text)(require, module, module.exports); return module.exports; }
let ui, service, validation, create, act;
test.before(async () => { [ui, service, validation, { create, act }] = await Promise.all([load('src/features/reader/desktopReadingPositionPanel.tsx'), load('src/services/desktopReadingPosition.ts'), load('packages/sync-core/src/validation.ts'), load(require.resolve('react-test-renderer'))]); });
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node?.children ? text(node.children) : '';
const commands = f => f.calls.map(row => row.command);
const mutations = f => commands(f).filter(command => /_(publish|continue|resolve|track_start|track_point|track_stop)$/.test(command));
async function mount(t, options = {}) {
  const f = createReadingFixture(options), old = globalThis.window; globalThis.window = f.window;
  const trackingFixture = options.tracking ? createReadingTrackingFixture(f) : null;
  let closes = 0, props = { localPaperId: 'local-reading-paper', reader: f.reader, active: true, onClose: () => closes++, ...(trackingFixture ? { tracking: trackingFixture.controller } : {}), ...options.props }, root;
  await act(async () => { root = create(createElement(ui.DesktopReadingPositionPanel, props)); });
  t.after(async () => { await act(async () => root.unmount()); globalThis.window = old; });
  return { ...f, root, trackingFixture, closes: () => closes,
    update: async patch => { props = { ...props, ...patch }; await act(async () => root.update(createElement(ui.DesktopReadingPositionPanel, props))); },
    setStatus: async (next, payload) => { f.current.status = next; await act(async () => f.emitChange(payload)); },
  };
}
function button(f, label) { const node = f.root.root.findAllByType('button').find(node => text(node) === label || node.props['aria-label'] === label); assert.ok(node, 'Button exists: ' + label); return node; }
async function click(f, label) { const node = button(f, label); assert.ok(!node.props.disabled, 'Button enabled: ' + label); await act(async () => node.props.onClick()); }
const radios = f => f.root.root.findAllByType('input').filter(node => node.props.type === 'radio');
async function choose(f, index) { const node = radios(f)[index]; assert.ok(node && !node.props.disabled); await act(async () => node.props.onChange()); }
async function prepare(f, task = 'publish') { const node = f.root.root.findByProps({ 'data-reading-task': task }); assert.ok(!node.props.disabled); await act(async () => node.props.onClick()); await click(f, '检查当前 PDF 与账号位置'); }
async function prepareResume(f) { await prepare(f, 'resume'); await choose(f, 0); await click(f, '核对接续位置'); }

test('all fixture positions satisfy the real closed ReadingPositionData schema', () => {
  for (const point of [readingData(), ...readingPreview().positions.map(row => row.data), readingPending().data, readingConflict().attempted.data, readingConflict().current.data]) assert.deepEqual(validation.validateEntityData('readingPosition', point), { ok: true, value: point });
});
test('service uses fixed tracking commands and conveys synchronous opaque scope change payloads', async () => {
  const f = createReadingFixture(), old = globalThis.window; globalThis.window = f.window;
  try { const s = service.desktopReadingPosition, changes = []; const unsubscribe = await s.onChanged(change => changes.push(change));
    f.emitChange(); f.emitChange({ readingScopeKey: 'scope-b-epoch-2' }); f.emitChange({ readingScopeKey: null }); f.emitChange({ readingScopeKey: 1 }); unsubscribe();
    assert.deepEqual(changes, [undefined, { readingScopeKey: 'scope-b-epoch-2' }, { readingScopeKey: null }, undefined]);
    f.current.lastPreview = readingPreview(); await s.startTracking({ token: readingId(20) }); const trackingId = f.current.status.tracking.trackingId;
    const point = { pageIndex: 2, offsetRatio: .25, furthestPageIndex: 9, furthestOffsetRatio: .625, observedAt: readingSnapshot().observedAt };
    await s.recordTracked({ trackingId, sequence: 1, point }); await s.stopTracking({ trackingId });
    assert.deepEqual(f.calls.map(row => row.command), ['desktop_reading_track_start', 'desktop_reading_track_point', 'desktop_reading_track_stop']); assert.deepEqual(f.calls[1].args, { trackingId, sequence: 1, point });
  } finally { globalThis.window = old; }
});
test('opening and reopening read only local status; no bytes, preview, jump, send or tracker enable', async t => {
  const f = await mount(t, { tracking: true }); assert.deepEqual(commands(f), ['desktop_reading_status']); assert.deepEqual(f.readerCalls, []); assert.deepEqual(f.trackingFixture.calls, []);
  await f.update({ active: false }); await f.update({ active: true }); assert.deepEqual(commands(f), ['desktop_reading_status', 'desktop_reading_status']); assert.deepEqual(f.readerCalls, []); assert.deepEqual(mutations(f), []);
});
test('inactive and signed-out embeddings never capture a PDF or issue a preview', async t => {
  const f = await mount(t, { props: { active: false } }); assert.deepEqual(commands(f), []); assert.equal(f.root.toJSON(), null);
  await f.update({ active: true }); await f.setStatus(readingStatus({ scopeKey: null, supported: false })); assert.deepEqual(f.readerCalls, []); assert.equal(f.root.root.findAllByProps({ 'data-reading-task': 'publish' }).length, 0);
});
test('publication requires checking, review and explicit confirmation; account recent and furthest remain distinct', async t => {
  const f = await mount(t); await prepare(f); const out = text(f.root.toJSON()); assert.match(out, /第 4 页 · 页内 37.5%/); assert.match(out, /第 6 页 · 页内 25%/); assert.match(out, /最远进度：第 9 页 · 页内 70%/); assert.deepEqual(mutations(f), []);
  await click(f, '核对并发布这个位置'); assert.deepEqual(mutations(f), []); await click(f, '确认发布此位置'); assert.deepEqual(mutations(f), ['desktop_reading_publish']); assert.deepEqual(f.calls.find(row => row.command === 'desktop_reading_publish').args, { token: f.current.lastPreview.token }); assert.match(text(f.root.toJSON()), /已发送到账号/);
});
test('an own tombstone requires explicit restore wording and confirmation', async t => {
  const f = await mount(t, { preview: { publicationAction: 'restore', own: readingOwn({ deletedAt: '2026-11-04T01:00:00.000Z' }) } }); await prepare(f); await click(f, '核对恢复已删除的位置'); assert.match(text(f.root.toJSON()), /恢复此设备已删除的账号位置/); assert.deepEqual(mutations(f), []); await click(f, '确认恢复并发布此位置'); assert.deepEqual(mutations(f), ['desktop_reading_publish']);
});
test('matching linked versions require an explicit selection with no default and send the selected binding', async t => {
  const second = readingSource({ bindingId: readingId(90), attachmentVersionId: readingId(91), title: '同内容的另一账号版本' });
  const f = await mount(t, { versions: [readingSource(), second] }); await prepare(f); assert.deepEqual(radios(f).map(row => row.props.checked), [false, false]); assert.ok(button(f, '检查所选版本').props.disabled); assert.ok(!commands(f).includes('desktop_reading_preview'));
  await choose(f, 1); await click(f, '检查所选版本'); assert.equal(f.calls.find(row => row.command === 'desktop_reading_preview').args.capture.bindingId, second.bindingId); assert.match(text(f.root.toJSON()), /同内容的另一账号版本/);
});
test('resume has no default, shows the exact recent point and applies only after review and confirmation with zero publication', async t => {
  const f = await mount(t); await prepare(f, 'resume'); assert.deepEqual(radios(f).map(row => row.props.checked), [false, false]); assert.ok(button(f, '核对接续位置').props.disabled); assert.deepEqual(f.readerApplied, []);
  await choose(f, 0); await click(f, '核对接续位置'); assert.match(text(f.root.toJSON()), /第 2 页 · 页内 12.5%/); assert.deepEqual(f.readerApplied, []); await click(f, '确认在当前 PDF 接续');
  assert.deepEqual(f.readerApplied, [{ sha256: 'a'.repeat(64), sizeBytes: 8192, pageCount: 12, pageIndex: 1, offsetRatio: .125 }]); assert.deepEqual(mutations(f), []); assert.match(text(f.root.toJSON()), /已在当前 PDF 接续到第 2 页/);
});
test('an unreachable exact resume reports the window/zoom limitation without applying a point or claiming success', async t => {
  const f = await mount(t); await prepareResume(f); f.overrides.set('reader_resume', () => { throw Object.assign(Error('READING_POSITION_UNREACHABLE'), { code: 'READING_POSITION_UNREACHABLE' }); });
  await click(f, '确认在当前 PDF 接续'); assert.deepEqual(f.readerApplied, []); assert.deepEqual(mutations(f), []);
  assert.match(text(f.root.toJSON()), /当前窗口无法准确显示所选位置，请调整窗口或 PDF 缩放后重新检查/); assert.doesNotMatch(text(f.root.toJSON()), /已在当前 PDF 接续/);
});
test('double-clicking a captured confirmation dispatches one immutable publication', async t => {
  const f = await mount(t), pending = deferred(); await prepare(f); await click(f, '核对并发布这个位置'); f.overrides.set('desktop_reading_publish', () => pending.promise); const action = button(f, '确认发布此位置').props.onClick;
  await act(async () => { action(); action(); }); assert.equal(mutations(f).length, 1); await act(async () => pending.resolve(readingStatus({ revision: 2 })));
});
test('an action busy snapshot cannot overwrite the later idle notification and leave the sheet stuck', async t => {
  const f = await mount(t), pending = deferred(); await prepare(f); await click(f, '核对并发布这个位置'); f.overrides.set('desktop_reading_publish', () => pending.promise); await click(f, '确认发布此位置');
  await f.setStatus(readingStatus({ revision: 2, busy: false })); await act(async () => pending.resolve(readingStatus({ revision: 2, busy: true })));
  assert.equal(button(f, '返回阅读位置').props.disabled, false);
});
for (const change of ['revision', 'entityId', 'deviceId', 'page', 'source']) test('changed resume ' + change + ' prevents any Reader apply', async t => {
  const f = await mount(t); await prepareResume(f); f.overrides.set('desktop_reading_resume', () => {
    const row = f.current.lastPreview.positions[0], source = readingSource(); return { scopeKey: readingScope, source: change === 'source' ? { ...source, sha256: 'b'.repeat(64) } : source,
      position: change === 'page' ? { ...row.data, pageIndex: 2 } : row.data, origin: { entityId: change === 'entityId' ? readingId(99) : row.entityId, revision: change === 'revision' ? row.revision + 1 : row.revision, deviceId: change === 'deviceId' ? readingId(99) : row.deviceId, deviceName: row.deviceName } };
  }); await click(f, '确认在当前 PDF 接续'); assert.deepEqual(f.readerApplied, []); assert.match(text(f.root.toJSON()), /检查后已有变化/);
});
test('a changed status revision during resume verification rejects the prior review', async t => {
  const f = await mount(t), pending = deferred(); await prepareResume(f); f.overrides.set('desktop_reading_resume', () => pending.promise); await click(f, '确认在当前 PDF 接续');
  const row = f.current.lastPreview.positions[0]; await f.setStatus(readingStatus({ revision: 2 })); await act(async () => pending.resolve({ scopeKey: readingScope, source: readingSource(), position: row.data, origin: { entityId: row.entityId, revision: row.revision, deviceId: row.deviceId, deviceName: row.deviceName } })); assert.deepEqual(f.readerApplied, []);
});
for (const stage of ['capture', 'preview', 'resume']) test('A to B to A ignores a late ' + stage + ' without restoring stale choices', async t => {
  const f = await mount(t), pending = deferred(); if (stage === 'capture') f.overrides.set('reader_capture', () => pending.promise); if (stage === 'preview') f.overrides.set('desktop_reading_preview', () => pending.promise);
  if (stage === 'resume') { await prepareResume(f); f.overrides.set('desktop_reading_resume', () => pending.promise); await click(f, '确认在当前 PDF 接续'); } else await prepare(f);
  await f.setStatus(readingStatus({ scopeKey: 'owner-b' })); await f.setStatus(readingStatus());
  await act(async () => pending.resolve(stage === 'capture' ? readingSnapshot() : stage === 'preview' ? readingPreview() : { scopeKey: readingScope, source: readingSource(), position: readingPosition().data, origin: readingPosition() }));
  assert.equal(f.root.root.findAllByProps({ 'data-reading-source': true }).length, 0); assert.deepEqual(f.readerApplied, []); assert.deepEqual(mutations(f), []); assert.equal(radios(f).length, 0);
});
test('synchronous scope notifications revoke an already-dispatched Reader apply through A to B to A before delayed status', async t => {
  const f = await mount(t), pending = deferred(), statuses = deferred(); await prepareResume(f); f.overrides.set('reader_resume', () => pending.promise); await click(f, '确认在当前 PDF 接续'); assert.equal(f.readerCalls.filter(row => row.action === 'resume').length, 1);
  f.overrides.set('desktop_reading_status', () => statuses.promise); await act(async () => { f.emitChange({ readingScopeKey: 'owner-b-epoch-2' }); f.emitChange({ readingScopeKey: readingScope }); });
  await act(async () => pending.resolve()); assert.deepEqual(f.readerApplied, []); await act(async () => statuses.resolve(readingStatus())); assert.doesNotMatch(text(f.root.toJSON()), /已在当前 PDF 接续/);
});
test('same-scope busy notifications preserve a pending explicit Reader apply', async t => {
  const f = await mount(t), pending = deferred(); await prepareResume(f); f.overrides.set('reader_resume', () => pending.promise); await click(f, '确认在当前 PDF 接续'); await f.setStatus(readingStatus({ busy: true }), { readingScopeKey: readingScope });
  await act(async () => pending.resolve()); assert.equal(f.readerApplied.length, 1);
});
test('changing loaded Reader identity rejects a late full-byte capture and stale publication callback', async t => {
  const f = await mount(t), pending = deferred(); f.overrides.set('reader_capture', () => pending.promise); await prepare(f); await f.update({ reader: { ...f.reader, id: readingId(51) } }); await act(async () => pending.resolve(readingSnapshot())); assert.ok(!commands(f).includes('desktop_reading_versions'));
  f.overrides.delete('reader_capture'); await prepare(f); await click(f, '核对并发布这个位置'); const stale = button(f, '确认发布此位置').props.onClick; await f.update({ reader: { ...f.reader, id: readingId(52) } }); await act(async () => stale()); assert.deepEqual(mutations(f), []);
});
test('stopping a wait while full-byte capture is pending suppresses late preview without discarding original state', async t => {
  const f = await mount(t), pending = deferred(); f.overrides.set('reader_capture', () => pending.promise); await prepare(f); await click(f, '停止本次等待'); await act(async () => pending.resolve(readingSnapshot())); assert.ok(commands(f).includes('desktop_reading_stop')); assert.ok(!commands(f).includes('desktop_reading_versions')); assert.deepEqual(mutations(f), []);
});
test('rechecking revokes the old reviewed token and its captured publish callback', async t => {
  const f = await mount(t); await prepare(f); await click(f, '核对并发布这个位置'); const stale = button(f, '确认发布此位置').props.onClick; await click(f, '返回核对'); await click(f, '重新检查当前 PDF'); await act(async () => stale()); assert.deepEqual(mutations(f), []); assert.equal(commands(f).filter(name => name === 'desktop_reading_preview').length, 2);
});
test('unknown original requests and foreign-device conflicts stay explicit and cannot become new edits', async t => {
  const f = await mount(t, { status: { pending: 2, continuable: 1, conflicts: 1 }, preview: { pendingRows: [readingPending(), readingPending({ opId: readingId(33), stage: 'device-blocked', errorCode: 'DEVICE_CHANGED' })], conflicts: [readingConflict({ canResolve: false, reason: 'READING_DEVICE_MISMATCH' })] } });
  await prepare(f, 'pending'); assert.match(text(f.root.toJSON()), /上次发送结果未知/); assert.match(text(f.root.toJSON()), /原请求属于其他登录设备/); assert.ok(radios(f).every(node => node.props.disabled)); assert.ok(button(f, '确认这项选择').props.disabled); assert.deepEqual(mutations(f), []);
  await click(f, '继续处理原请求'); assert.deepEqual(mutations(f), ['desktop_reading_continue']); assert.deepEqual(f.calls.find(row => row.command === 'desktop_reading_continue').args, {});
});
test('current-device conflict choices default empty and preserve explicit expected revision', async t => {
  const f = await mount(t, { status: { conflicts: 1 }, preview: { conflicts: [readingConflict()] } }); await prepare(f, 'pending'); assert.ok(button(f, '确认这项选择').props.disabled); await choose(f, 1); await click(f, '确认这项选择');
  assert.deepEqual(f.calls.find(row => row.command === 'desktop_reading_resolve').args, { conflictId: readingId(31), choice: 'attempted', expectedRevision: 5 });
});
test('save-only recovery reuses a received result and never calls publish, continue or tracking', async t => {
  const f = await mount(t, { tracking: true, status: { saveUnconfirmed: true, pending: 1, continuable: 1 } }); assert.match(text(f.root.toJSON()), /只重试本机保存会继续使用这个结果/); await click(f, '只重试本机保存'); assert.ok(commands(f).includes('desktop_reading_retry_save')); assert.deepEqual(mutations(f), []); assert.deepEqual(f.readerCalls, []); assert.doesNotMatch(text(f.root.toJSON()), /已发送到账号/);
});
test('save-unconfirmed publication result never claims sent success or automatically retries', async t => {
  const f = await mount(t); await prepare(f); await click(f, '核对并发布这个位置'); f.overrides.set('desktop_reading_publish', () => readingStatus({ revision: 2, saveUnconfirmed: true, pending: 1 })); await click(f, '确认发布此位置'); assert.doesNotMatch(text(f.root.toJSON()), /这个位置已发送到账号/); assert.match(text(f.root.toJSON()), /本机保存尚未确认/); assert.deepEqual(mutations(f), ['desktop_reading_publish']);
});
test('capability downgrade retains full private backup; cancelled backup stays neutral', async t => {
  const f = await mount(t); await prepare(f); await f.setStatus(readingStatus({ supported: false })); assert.equal(f.root.root.findAllByProps({ 'data-reading-source': true }).length, 0);
  f.overrides.set('desktop_reading_export', () => ({ status: 'cancelled' })); await click(f, '导出阅读位置备份'); assert.match(text(f.root.toJSON()), /已取消导出，原记录仍保留/); assert.doesNotMatch(text(f.root.toJSON()), /记录已导出备份/); assert.deepEqual(f.calls.find(row => row.command === 'desktop_reading_export').args, {});
});
test('closed diagnostics keep IDs, hashes and request fields out of ordinary content', async t => {
  const f = await mount(t, { preview: { localDraft: readingDraft(), pendingRows: [readingPending()] } }); await prepare(f, 'pending'); const out = text(f.root.toJSON());
  for (const value of [readingId(1), readingId(2), readingId(3), readingId(30), readingId(60), 'a'.repeat(64), 'local-reading-paper', 'local-reading-pdf']) assert.ok(!out.includes(value), value); assert.doesNotMatch(out, /attachmentVersionId|originDeviceId|sessionId|opId|scopeKey/);
});
test('tracking is explicit after proof, permits pending original requests and uses local-only wording', async t => {
  const f = await mount(t, { tracking: true, status: { pending: 1 }, preview: { publicationAction: 'blocked', publicationReason: 'READING_PENDING', pendingRows: [readingPending()] } });
  await prepare(f); assert.deepEqual(f.trackingFixture.calls, []); assert.ok(!button(f, '记录本次阅读位置').props.disabled); assert.ok(button(f, '核对并发布这个位置').props.disabled); await click(f, '记录本次阅读位置');
  assert.equal(f.trackingFixture.calls[0].action, 'start'); assert.deepEqual(mutations(f), ['desktop_reading_track_start']); assert.match(text(f.root.toJSON()), /本机记录已开启；发送到账号需另行检查并确认/); assert.doesNotMatch(text(f.root.toJSON()), /这个位置已发送到账号/);
});
test('retained local draft displays recent and furthest separately without suggesting account publication', async t => {
  const f = await mount(t, { tracking: true, preview: { localDraft: readingDraft({ capture: { ...readingSnapshot({ pageIndex: 1, offsetRatio: .125 }), bindingId: readingId(1) }, furthestPageIndex: 9, furthestOffsetRatio: .625 }) } }); await prepare(f);
  const out = text(f.root.root.findByProps({ 'data-reading-local-draft': true })); assert.match(out, /第 2 页 · 页内 12.5%/); assert.match(out, /最远进度：第 10 页 · 页内 62.5%/); assert.match(out, /不表示已发送到账号/);
});
test('closing and reopening the sheet leaves an enabled session running; only explicit stop calls controller.stop', async t => {
  const f = await mount(t, { tracking: true }); await prepare(f); await click(f, '记录本次阅读位置'); await click(f, '关闭阅读位置'); assert.equal(f.closes(), 1); assert.deepEqual(f.trackingFixture.calls.map(row => row.action), ['start']);
  await f.update({ active: false }); await f.update({ active: true }); assert.match(text(f.root.toJSON()), /正在记录本次阅读位置/); assert.deepEqual(f.trackingFixture.calls.map(row => row.action), ['start']); await click(f, '停止记录'); assert.deepEqual(f.trackingFixture.calls.map(row => row.action), ['start', 'stop']); assert.match(text(f.root.toJSON()), /已停止本次阅读记录/);
});
test('stale tracking enable callback cannot start for a different owner or loaded Reader', async t => {
  const f = await mount(t, { tracking: true }); await prepare(f); const stale = button(f, '记录本次阅读位置').props.onClick; await f.setStatus(readingStatus({ scopeKey: 'owner-b' })); await act(async () => stale()); assert.deepEqual(f.trackingFixture.calls, []);
  await f.setStatus(readingStatus()); await prepare(f); const second = button(f, '记录本次阅读位置').props.onClick; await f.update({ reader: { ...f.reader, id: readingId(51) } }); await act(async () => second()); assert.deepEqual(f.trackingFixture.calls, []);
});
test('failed explicit tracking stop remains unconfirmed with an active ID and offers a working stop retry', async t => {
  const f = await mount(t, { tracking: true }); await prepare(f); await click(f, '记录本次阅读位置'); const trackingId = f.current.status.tracking.trackingId;
  f.overrides.set('tracking_stop', () => { throw Object.assign(Error('READING_STORAGE_CHANGED'), { code: 'READING_STORAGE_CHANGED' }); }); await click(f, '停止记录');
  assert.match(text(f.root.toJSON()), /本次阅读记录遇到问题/); assert.doesNotMatch(text(f.root.toJSON()), /已停止本次阅读记录|本次阅读记录已停止/); assert.equal(f.current.status.tracking.trackingId, trackingId); assert.ok(!button(f, '重试停止记录').props.disabled);
  await click(f, '重新检查当前 PDF'); assert.equal(f.root.root.findAllByProps({ 'data-reading-enable': true }).length, 0); f.overrides.delete('tracking_stop'); await click(f, '重试停止记录');
  assert.equal(f.current.status.tracking, null); assert.deepEqual(f.trackingFixture.calls.filter(row => row.action === 'stop').map(row => row.trackingId), [trackingId, trackingId]); assert.match(text(f.root.toJSON()), /已停止本次阅读记录/);
});
test('tracking save failure is visible and never presented as account success', async t => {
  const f = await mount(t, { tracking: true }); await prepare(f); f.overrides.set('tracking_start', () => { throw Object.assign(Error('READING_SAVE_UNCONFIRMED'), { code: 'READING_SAVE_UNCONFIRMED' }); }); await click(f, '记录本次阅读位置'); assert.match(text(f.root.toJSON()), /本机保存尚未确认/); assert.doesNotMatch(text(f.root.toJSON()), /本机记录已开启|这个位置已发送到账号/); assert.deepEqual(mutations(f), []);
});
