const path = require('node:path');
const { isWithin, resolveAuthorizedPath } = require('./pathAccess.cjs');

function key(value) { return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value); }
function assertSourcePath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || /^\\\\[?.]\\|^\\\?\?\\/.test(value.replaceAll('/', '\\'))) {
    throw new Error('Invalid import source path.');
  }
}

// Native picker results and explicitly selected Zotero roots are main-process
// capabilities, never settings copied from an adopted library or renderer flags.
function createSourceAccess(dialog) {
  const selected = new Map();
  const roots = new Map();

  function rememberPicked(paths) {
    for (const source of paths) {
      assertSourcePath(source);
      selected.set(key(source), resolveAuthorizedPath(source, () => true));
    }
  }

  function rememberRootMapping(source, actual) {
    roots.set(key(source), { raw: source, actual });
    roots.set(key(actual), { raw: actual, actual });
    return actual;
  }

  function rememberZoteroRoot(source) {
    assertSourcePath(source);
    return rememberRootMapping(source, resolveAuthorizedPath(source, () => true));
  }

  async function authorizeZoteroRoot(source, { trusted = false } = {}) {
    assertSourcePath(source);
    if (roots.has(key(source))) return roots.get(key(source)).actual;
    if (trusted) return rememberZoteroRoot(source);
    const approved = await authorize([source], { mode: 'read' });
    return rememberRootMapping(source, approved.get(source));
  }

  function known(source) {
    assertSourcePath(source);
    if (selected.has(key(source))) return selected.get(key(source));
    for (const root of roots.values()) {
      if (isWithin(root.raw, source)) {
        return resolveAuthorizedPath(path.join(root.actual, path.relative(root.raw, source)), (candidate) => isWithin(root.actual, candidate));
      }
    }
    return null;
  }

  async function confirm(paths, mode, resolved = false) {
    const pages = [];
    for (const source of paths) {
      const text = JSON.stringify(source);
      if (text.length > 1500) throw new Error('Import source is too long to safely display.');
      if (!pages.length || pages.at(-1).length >= 8 || pages.at(-1).join('\n').length + text.length > 1500) pages.push([]);
      pages.at(-1).push(text);
    }
    for (const [index, page] of pages.entries()) {
      const result = await dialog.showMessageBox({
        type: 'warning', title: '确认导入源文件 / Approve Source Files',
        message: `${resolved ? '实际源文件 / Resolved sources' : '源文件 / Source files'} ${index + 1}/${pages.length}`,
        detail: `${page.join('\n')}\n\n这些文件由外部数据列出，而非本次文件选择器直接选定。继续后正文可能写入当前共享文库。 / These files were listed by external data, not directly selected in the file picker. Their contents may be copied into the current shared library.\n\n${mode === 'move' ? 'MOVE 会删除原文件。 / MOVE removes the originals.\n\n' : ''}继续后才检查路径。网络、映射盘或链接可能连接远程服务器并发送 Windows 身份验证信息。 / Paths are inspected only after consent. Network paths, mapped drives and links may contact remote servers and send Windows authentication information.`,
        buttons: ['取消 / Cancel', '批准这些源文件 / Approve These Sources'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) throw new Error('Source file approval canceled.');
    }
  }

  async function authorize(paths, { mode = 'copy' } = {}) {
    if (!Array.isArray(paths)) throw new Error('Import source paths must be an array.');
    paths.forEach(assertSourcePath);
    const mappings = new Map(); const unknown = [];
    for (const source of new Set(paths)) {
      let actual;
      try { actual = known(source); } catch { /* A new link target needs explicit source consent. */ }
      if (actual) mappings.set(source, actual);
      else unknown.push(source);
    }
    if (unknown.length) {
      await confirm(unknown, mode);
      // The first dialog disclosed network/link risks. Show changed resolved
      // names again before reading bytes or exporting them to a shared library.
      const resolved = unknown.map((source) => resolveAuthorizedPath(source, () => true));
      const changed = resolved.filter((actual, index) => key(actual) !== key(unknown[index]));
      if (changed.length) await confirm(changed, mode, true);
      for (const [index, source] of unknown.entries()) {
        mappings.set(source, resolved[index]);
        selected.set(key(source), resolved[index]);
      }
    }
    return mappings;
  }

  return { rememberPicked, rememberZoteroRoot, authorizeZoteroRoot, known, authorize };
}
module.exports = { createSourceAccess, assertSourcePath };
