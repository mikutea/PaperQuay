const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { DatabaseSync, withTransaction } = require('./backend/nodeSqlite.cjs');
const { canonicalPath } = require('./backend/pathAccess.cjs');

const REGISTRY_NAME = 'paperquay-library-locations.json';
const LIBRARY_FILE = 'paperquay-library.sqlite';

function comparable(directory) {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function profileKey(directory) {
  try { return comparable(canonicalPath(directory)); }
  catch { return comparable(directory); } // Offline volumes still retain their registered identity.
}

function fileAccessPolicy(details) {
  if (!details.fileAccessResolved) throw new Error('Library file access has not been inspected after consent.');
  return {
    storageDirectory: details.storageDirectory,
    storageRoot: details.storageRoot,
    importMode: details.importMode,
    attachmentRoots: details.attachmentRoots,
  };
}

function assertFilesystemPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Invalid absolute filesystem path.');
  // Device namespaces are not ordinary library/PDF paths. Check the spelling
  // before normalization or any filesystem operation, including on Windows.
  const windowsPath = filePath.replace(/\//g, '\\');
  if (/^\\\\[?.]\\|^\\\?\?\\/.test(windowsPath)) {
    throw new Error('Windows device paths are not supported for library files.');
  }
}

function assertApprovedImportSettings(details, approved) {
  if (approved && (comparable(details.storageDirectory) !== comparable(approved.storageDirectory) || details.importMode !== approved.importMode)) {
    throw new Error('文库文件访问设置已更改。请通过“打开已有文库”重新确认。 / Library file access settings changed. Use Open Existing Library to approve them again.');
  }
}

function effectiveRelativePath(storageDirectory, relativePath, resolvePath = canonicalPath) {
  if (relativePath == null || relativePath === '') return null;
  if (typeof relativePath !== 'string') throw new Error('Unsafe attachment relative path.');
  relativePath = relativePath.trim();
  if (!relativePath) return null;
  if (/^[\\/]|^[a-z]:/i.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
    throw new Error('Unsafe attachment relative path.');
  }
  const target = resolvePath(path.join(storageDirectory, relativePath));
  const relative = path.relative(comparable(resolvePath(storageDirectory)), comparable(target));
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Attachment relative path escapes storage root.');
  return target;
}

function assertApprovedFileAccess(details, approved) {
  if (!approved) return;
  const trustedRoots = [...approved.attachmentRoots, approved.storageRoot];
  const allowed = comparable(details.storageDirectory) === comparable(approved.storageDirectory) &&
    comparable(details.storageRoot) === comparable(approved.storageRoot) && details.importMode === approved.importMode &&
    details.attachmentRoots.every((directory) => trustedRoots.some((root) => {
      const relative = path.relative(comparable(root), comparable(directory));
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep);
    }));
  if (!allowed) throw new Error('文库文件访问设置已更改。请通过“打开已有文库”重新确认。 / Library file access settings changed. Use Open Existing Library to approve them again.');
}

function inspectLibraryDirectory(directory, {
  allowProfileDirectory = false, verifyIntegrity = true, inspectAttachmentRoots = verifyIntegrity,
  resolveFileAccess = false, approvedFileAccess = null, expectedFileAccessSignature = null,
} = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('请选择包含 PaperQuay 文库数据库的完整目录。 / Select an existing PaperQuay library directory.');
  }
  assertFilesystemPath(directory);
  const candidates = (allowProfileDirectory ? [directory, path.join(directory, 'PaperQuay')] : [directory])
    .filter((candidate) => {
      // existsSync would follow a database symlink (possibly to an SMB host)
      // before the linked-companion check below can reject it.
      try {
        if (candidate !== directory) {
          const parent = fs.lstatSync(candidate);
          if (parent.isSymbolicLink()) throw new Error('Linked library companion paths are not supported.');
          if (!parent.isDirectory()) return false;
        }
        const stat = fs.lstatSync(path.join(candidate, LIBRARY_FILE));
        if (stat.isSymbolicLink()) throw new Error('Linked library companion paths are not supported.');
        return stat.isFile();
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      }
    });
  if (candidates.length !== 1) {
    throw new Error(candidates.length > 1
      ? '此目录包含多个文库，请选择具体文库目录。 / Multiple libraries found; select the exact library folder.'
      : '没有找到 paperquay-library.sqlite。不会新建或覆盖文库。 / Library database not found. No library will be created or overwritten.');
  }
  const dataDirectory = fs.realpathSync(candidates[0]);
  for (const name of [LIBRARY_FILE, 'paperquay-notes.sqlite', 'paperquay-rag.sqlite', '.backup-snapshots', '.mineru-cache', '.downloads', '.screenshots']) {
    for (const suffix of (name.endsWith('.sqlite') ? ['', '-wal', '-shm', '-journal'] : [''])) {
      const candidate = path.join(dataDirectory, name + suffix);
      let link = false;
      try { link = fs.lstatSync(candidate).isSymbolicLink(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (link || (fs.existsSync(candidate) && comparable(canonicalPath(candidate)) !== comparable(path.join(canonicalPath(dataDirectory), name + suffix)))) {
        throw new Error('文库附属路径包含链接，未切换文库。 / Linked library companion paths are not supported.');
      }
    }
  }
  if (verifyIntegrity) {
    for (const name of ['paperquay-notes.sqlite', 'paperquay-rag.sqlite']) {
      const candidate = path.join(dataDirectory, name);
      if (!fs.existsSync(candidate)) continue;
      const companion = new DatabaseSync(candidate, { readOnly: true, timeout: 1000 });
      try {
        if (Object.values(companion.prepare('PRAGMA quick_check(1)').get())[0] !== 'ok') throw new Error('Companion database integrity check failed: ' + name);
      } finally { companion.close(); }
    }
  }
  const databasePath = path.join(dataDirectory, LIBRARY_FILE);
  const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 1000 });
  try {
    if (verifyIntegrity) {
      const result = db.prepare('PRAGMA quick_check(1)').get();
      if (Object.values(result)[0] !== 'ok') throw new Error('文库完整性检查失败。 / Library integrity check failed.');
    }
    const papers = db.prepare('PRAGMA table_info(papers)').all().map((row) => row.name);
    const attachments = db.prepare('PRAGMA table_info(attachments)').all().map((row) => row.name);
    if (!['id', 'title', 'imported_at'].every((column) => papers.includes(column)) || !attachments.includes('stored_path')) {
      throw new Error('此数据库不是支持的 PaperQuay 文库。 / Not a supported PaperQuay library.');
    }
    const settings = Object.fromEntries(db.prepare("SELECT key, value_json FROM library_settings WHERE key IN ('storageDir', 'importMode')")
      .all().map((row) => [row.key, JSON.parse(row.value_json)]));
    const storageDirectory = settings.storageDir || path.join(dataDirectory, 'paperquay-data');
    const importMode = settings.importMode || 'copy';
    if (typeof storageDirectory !== 'string' || !path.isAbsolute(storageDirectory) || !['copy', 'move', 'keep'].includes(importMode)) {
      throw new Error('文库包含无效的 PDF 导入设置。 / Invalid PDF import settings in this library.');
    }
    assertFilesystemPath(storageDirectory);
    assertApprovedImportSettings({ storageDirectory, importMode }, approvedFileAccess);
    const declaredAttachments = inspectAttachmentRoots
      ? db.prepare(`SELECT DISTINCT stored_path${attachments.includes('relative_path') ? ', relative_path' : ''} FROM attachments ORDER BY stored_path${attachments.includes('relative_path') ? ', relative_path' : ''}`).all()
      : [];
    // Validate every supplied spelling before resolving even the first one.
    for (const row of declaredAttachments) {
      assertFilesystemPath(row.stored_path);
      effectiveRelativePath(storageDirectory, row.relative_path, (value) => path.resolve(value));
    }
    const fileAccessSignature = createHash('sha256').update(JSON.stringify({ storageDirectory, importMode, declaredAttachments })).digest('hex');
    if (expectedFileAccessSignature && fileAccessSignature !== expectedFileAccessSignature) {
      throw new Error('文库的导入设置已更改，请重新选择并确认。 / Library import settings changed. Select and approve them again.');
    }
    // Metadata preview/startup must not probe PDF volumes. A drive letter can
    // be mapped, and a local-looking path can traverse a remote symlink.
    const resolveReference = resolveFileAccess ? canonicalPath : (value) => path.resolve(value);
    const attachmentRoots = [];
    if (inspectAttachmentRoots) {
      const roots = new Set();
      for (const row of declaredAttachments) {
        const target = resolveReference(row.stored_path);
        roots.add(path.dirname(target));
        const effective = effectiveRelativePath(storageDirectory, row.relative_path, resolveReference);
        if (effective) roots.add(path.dirname(effective));
      }
      attachmentRoots.push(...[...roots].sort());
    }
    return {
      dataDirectory,
      databasePath,
      storageDirectory,
      storageRoot: resolveFileAccess ? canonicalPath(storageDirectory) : approvedFileAccess?.storageRoot || path.resolve(storageDirectory),
      fileAccessResolved: resolveFileAccess,
      fileAccessSignature,
      importMode,
      attachmentRoots,
      paperCount: Number(db.prepare('SELECT count(*) AS count FROM papers').get().count),
      attachmentCount: Number(db.prepare('SELECT count(*) AS count FROM attachments').get().count),
    };
  } finally {
    db.close();
  }
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    const directory = path.dirname(registryPath);
    if (fs.existsSync(directory) && fs.readdirSync(directory).some((name) => name.startsWith(path.basename(registryPath) + '.') && name.endsWith('.backup'))) {
      throw new Error('文库位置记录已丢失，但仍有备份。请选择已有文库恢复。 / Library location record is missing; recover an existing library using its backup.');
    }
    return { version: 1, defaultProfileDirectory: '', libraries: [] };
  }
  const value = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.libraries) || value.libraries.length > 100 ||
      typeof value.defaultProfileDirectory !== 'string' ||
      (value.defaultProfileDirectory && !path.isAbsolute(value.defaultProfileDirectory)) ||
      value.libraries.some((entry) => typeof entry?.profileDirectory !== 'string' || !path.isAbsolute(entry.profileDirectory) ||
        typeof entry?.dataDirectory !== 'string' || !path.isAbsolute(entry.dataDirectory) ||
        (entry.approvedFileAccess != null && (
          typeof entry.approvedFileAccess.storageDirectory !== 'string' || !path.isAbsolute(entry.approvedFileAccess.storageDirectory) ||
          typeof entry.approvedFileAccess.storageRoot !== 'string' || !path.isAbsolute(entry.approvedFileAccess.storageRoot) ||
          !['copy', 'move', 'keep'].includes(entry.approvedFileAccess.importMode) ||
          !Array.isArray(entry.approvedFileAccess.attachmentRoots) ||
          entry.approvedFileAccess.attachmentRoots.some((root) => typeof root !== 'string' || !path.isAbsolute(root))
        )))) {
    throw new Error('文库位置记录无效。请选择已有文库，不会自动创建空库。 / Invalid library location record. Choose an existing library.');
  }
  return value;
}

function writeRegistry(registryPath, value) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const id = randomUUID();
  const temporary = `${registryPath}.${id}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
    // Keep the previous pointer as a recovery record. Library files themselves
    // are never copied, moved, merged or deleted by a location switch.
    if (fs.existsSync(registryPath)) fs.copyFileSync(registryPath, `${registryPath}.${id}.backup`);
    fs.renameSync(temporary, registryPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readRegistryBackup(registryPath) {
  const directory = path.dirname(registryPath);
  if (!fs.existsSync(directory)) return null;
  const prefix = path.basename(registryPath) + '.';
  const candidates = fs.readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.backup'))
    .map((name) => ({ file: path.join(directory, name), modified: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.modified - a.modified);
  for (const candidate of candidates) {
    try { return readRegistry(candidate.file); } catch { /* Try the next intact recovery record. */ }
  }
  return null;
}

function mutateRegistry(registryPath, callback) {
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  // SQLite supplies an OS-backed interprocess lock, including automatic release
  // after a process crash. Hold it across the entire JSON read-modify-replace.
  const lockPath = registryPath + '.lock.sqlite';
  const run = () => {
    let lock;
    try { lock = new DatabaseSync(lockPath, { timeout: 5000 }); return withTransaction(lock, callback); }
    finally { lock?.close(); }
  };
  const corrupt = (error) => [11, 26].includes(error?.errcode); // SQLITE_CORRUPT / SQLITE_NOTADB, never SQLITE_BUSY.
  try { return run(); }
  catch (error) { if (!corrupt(error)) throw error; }
  const repairPath = lockPath + '.repair';
  const deadline = Date.now() + 5000;
  let repair;
  while (repair == null) {
    try {
      repair = fs.openSync(repairPath, 'wx', 0o600);
      fs.writeFileSync(repair, String(process.pid));
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = Number(fs.readFileSync(repairPath, 'utf8'));
        if (Number.isInteger(owner) && owner > 0) {
          try { process.kill(owner, 0); }
          catch (failure) { if (failure.code === 'ESRCH') { fs.unlinkSync(repairPath); continue; } }
        } else if (Date.now() - fs.statSync(repairPath).mtimeMs > 5000) {
          fs.unlinkSync(repairPath); continue;
        }
      } catch (failure) { if (failure.code === 'ENOENT') continue; throw failure; }
      if (Date.now() >= deadline) throw new Error('Library registry lock recovery is busy. Please retry.');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    // Another recovering process may already have fixed it. Recheck under the
    // repair guard, preserving only genuinely corrupt synchronization state.
    try { return run(); }
    catch (error) { if (!corrupt(error)) throw error; }
    fs.renameSync(lockPath, `${lockPath}.${randomUUID()}.corrupt`);
    return run();
  } finally { fs.closeSync(repair); fs.unlinkSync(repairPath); }
}

function createLibraryLocationManager({ app, dialog, argv = process.argv, restart }) {
  const registryPath = path.join(app.getPath('appData'), app.isPackaged ? REGISTRY_NAME : 'paperquay-development-library-locations.json');
  const initialProfile = app.getPath('userData');
  const explicitProfile = argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
  let active = null;
  let pending = null;
  let recoveryProfile = initialProfile;
  const approvedCloudFiles = new Set();
  const approvedReadFiles = new Set();

  function resolve() {
    let registry;
    try { registry = readRegistry(registryPath); }
    catch (error) {
      const backup = readRegistryBackup(registryPath);
      const wanted = !explicitProfile && backup?.defaultProfileDirectory ? backup.defaultProfileDirectory : initialProfile;
      const entry = backup?.libraries.find((item) => profileKey(item.profileDirectory) === profileKey(wanted));
      if (entry && fs.existsSync(entry.profileDirectory)) {
        recoveryProfile = entry.profileDirectory;
        app.setPath('userData', recoveryProfile);
      }
      throw error; // Recovery remains explicit; do not silently overwrite corruption.
    }
    let profileDirectory = !explicitProfile && registry.defaultProfileDirectory
      ? registry.defaultProfileDirectory : initialProfile;
    const entry = registry.libraries.find((item) => profileKey(item.profileDirectory) === profileKey(profileDirectory));
    if (entry) {
      profileDirectory = entry.profileDirectory;
      if (!fs.existsSync(profileDirectory)) {
        throw new Error(`原用户配置目录无法访问：${profileDirectory}\nProfile is unavailable. No empty replacement was created.`);
      }
      // Preserve Chromium settings even if only the external library is lost.
      // This runs before ready, including when validation below throws.
      recoveryProfile = profileDirectory;
      app.setPath('userData', profileDirectory);
      const details = inspectLibraryDirectory(entry.dataDirectory, {
        verifyIntegrity: false, approvedFileAccess: entry.approvedFileAccess,
      });
      assertApprovedFileAccess(details, entry.approvedFileAccess);
      active = { profileDirectory, ...details, approvedFileAccess: entry.approvedFileAccess, registered: true };
    } else {
      if (!explicitProfile && registry.defaultProfileDirectory) throw new Error('默认文库记录不完整。 / The default library record is incomplete.');
      recoveryProfile = profileDirectory;
      fs.mkdirSync(profileDirectory, { recursive: true });
      app.setPath('userData', profileDirectory);
      active = { profileDirectory, dataDirectory: path.join(profileDirectory, 'PaperQuay'), registered: false };
    }
    return { ...active };
  }

  function persistLocation(profileDirectory, dataDirectory, makeDefault, allowRecovery = false, approvedFileAccess = null) {
    return mutateRegistry(registryPath, () => {
      let registry;
      try { registry = readRegistry(registryPath); }
      catch (error) {
        if (!allowRecovery) throw error;
        registry = readRegistryBackup(registryPath) || { version: 1, defaultProfileDirectory: '', libraries: [] };
      }
      const key = profileKey(profileDirectory);
      const previous = registry.libraries.find((entry) => profileKey(entry.profileDirectory) === key);
      if (previous) profileDirectory = previous.profileDirectory;
      if (!previous && registry.libraries.length >= 100) {
        throw new Error('已达到文库配置数量上限，原记录未更改。 / Library profile limit reached. Existing records were preserved.');
      }
      if (previous && comparable(previous.dataDirectory) === comparable(dataDirectory) &&
          (!approvedFileAccess || JSON.stringify(previous.approvedFileAccess) === JSON.stringify(approvedFileAccess)) &&
          (!makeDefault || (registry.defaultProfileDirectory && profileKey(registry.defaultProfileDirectory) === key)) && (registry.defaultProfileDirectory || explicitProfile) && !allowRecovery) return;
      registry.libraries = registry.libraries.filter((entry) => profileKey(entry.profileDirectory) !== key);
      const sameLibrary = previous && comparable(previous.dataDirectory) === comparable(dataDirectory);
      registry.libraries.push({ profileDirectory, dataDirectory,
        ...((approvedFileAccess || (sameLibrary && previous.approvedFileAccess)) ?
          { approvedFileAccess: approvedFileAccess || previous.approvedFileAccess } : {}),
      });
      if (makeDefault || (!explicitProfile && !registry.defaultProfileDirectory)) registry.defaultProfileDirectory = profileDirectory;
      writeRegistry(registryPath, registry);
    });
  }

  function rememberActive({ makeDefault = false } = {}) {
    if (!active) throw new Error('No active library location.');
    // Ordinary launches only remember a pointer. Full integrity scans belong
    // to the explicit existing-library selection/recovery flow, not startup.
    const details = inspectLibraryDirectory(active.dataDirectory, {
      verifyIntegrity: false, approvedFileAccess: active.approvedFileAccess,
    });
    assertApprovedFileAccess(details, active.approvedFileAccess);
    persistLocation(active.profileDirectory, details.dataDirectory, makeDefault);
    active = { ...active, ...details, registered: true };
    return status();
  }

  function status() {
    if (!active) throw new Error('No active library location.');
    return {
      ...active,
      databasePath: path.join(active.dataDirectory, LIBRARY_FILE),
      registryPath,
    };
  }

  async function selectExisting() {
    const selected = await dialog.showOpenDialog({
      title: '打开已有 PaperQuay 文库 / Open Existing Library',
      properties: ['openDirectory'],
      defaultPath: active?.dataDirectory || initialProfile,
    });
    pending = null;
    if (selected.canceled || selected.filePaths.length !== 1) return null;
    const details = inspectLibraryDirectory(selected.filePaths[0], { allowProfileDirectory: true });
    pending = { token: randomUUID(), ...details };
    return { ...pending };
  }

  async function activateSelected(args) {
    if (!pending || args?.token !== pending.token) throw new Error('请重新选择文库。 / Select the library again.');
    const selected = pending;
    const current = status();
    const details = inspectLibraryDirectory(selected.dataDirectory);
    let approved = true;
    try { assertApprovedFileAccess(details, active.approvedFileAccess); } catch { approved = false; }
    if (approved && comparable(details.dataDirectory) === comparable(fs.realpathSync(current.dataDirectory))) {
      pending = null;
      return { unchanged: true, ...current };
    }
    const resolved = await approveSelectedFileAccess(details);
    if (!resolved) return { canceled: true };
    persistLocation(current.profileDirectory, resolved.dataDirectory, true, false, fileAccessPolicy(resolved));
    pending = null;
    restart();
    return { restarting: true };
  }

  async function confirmImportSettings(details) {
    const modeDescription = {
      copy: '复制：保留原文件 / Copy: keep the original file',
      move: '移动：将删除原位置的文件 / Move: REMOVE the original file from its location',
      keep: '保留原路径：不复制或移动 / Keep original path: no copy or move',
    }[details.importMode];
    const attachmentScope = details.attachmentRoots.length
      ? `${details.attachmentRoots.length} 个目录，下一步逐页确认 / ${details.attachmentRoots.length} roots; approve each page next`
      : '无现有附件 / No existing attachments';
    const answer = await dialog.showMessageBox({
      type: 'question',
      title: '切换文库并重启 / Switch Library and Restart',
      message: `打开已有文库（${details.paperCount} 篇）？ / Open existing library (${details.paperCount} papers)?`,
      detail: `${details.dataDirectory}\n\n此文库自带的后续 PDF 导入设置 / This library's settings for FUTURE PDF imports:\n存储目录 / Destination: ${JSON.stringify(details.storageDirectory)}${details.fileAccessResolved ? `\n实际目录 / Resolved destination: ${JSON.stringify(details.storageRoot)}` : ''}\n导入方式 / Mode: ${modeDescription}\n\n现有附件 / Existing attachments: ${attachmentScope}\n\n继续后才会检查这些路径。UNC、映射盘及符号链接可能连接远程服务器，并发送 Windows 身份验证信息；仅在信任全部路径及其链接目标时继续。 / Only after consent will these paths be inspected. UNC paths, mapped drives and symlinks may contact remote servers and send Windows authentication information. Continue only if you trust ALL paths and their link targets.\n\n共享目录可能向他人暴露文件。 / Shared locations may expose files to others.\n\n请先保存编辑内容并关闭使用此文库的其他实例。本次切换不会复制、合并或覆盖任一文库。 / Save edits and close other instances. This switch does not copy, merge or overwrite either library.`,
      buttons: ['取消 / Cancel', '信任导入设置并继续 / Trust Import Settings and Continue'], defaultId: 0, cancelId: 0,
      noLink: true,
    });
    if (answer.response !== 1) return false;
    return confirmAttachmentRoots(details.attachmentRoots);
  }

  async function confirmAttachmentRoots(attachmentRoots) {
    const pages = [];
    for (const root of attachmentRoots) {
      const text = JSON.stringify(root);
      if (text.length > 1500) throw new Error('附件目录过长，无法安全显示。 / Attachment root is too long to safely display.');
      const last = pages.at(-1);
      if (!last || last.length >= 8 || last.join('\n').length + text.length > 1500) pages.push([text]);
      else last.push(text);
    }
    for (const [index, roots] of pages.entries()) {
      const result = await dialog.showMessageBox({
        type: 'warning', title: '确认附件访问范围 / Approve Attachment Access',
        message: `附件目录 ${index + 1}/${pages.length} / Attachment roots ${index + 1}/${pages.length}`,
        detail: `${roots.join('\n')}\n\n检查网络、映射盘或链接路径可能连接远程服务器并发送 Windows 身份验证信息。 / Inspecting network, mapped-drive or linked paths may contact remote servers and send Windows authentication information.\n\n删除文献并选择删除文件时，会删除这些目录及其子目录内的附件原文件，包括文库外文件。 / Deleting papers with Delete Files can REMOVE original attachments in these directories and subdirectories, including files outside the library.\n仅在信任这一页的全部目录时继续。 / Continue only if you trust EVERY root on this page.`,
        buttons: ['取消 / Cancel', '信任本页目录 / Trust These Roots'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (result.response !== 1) return false;
    }
    return true;
  }

  function validateUnchangedSettings(approved) {
    const current = inspectLibraryDirectory(approved.dataDirectory, {
      resolveFileAccess: approved.fileAccessResolved === true, expectedFileAccessSignature: approved.fileAccessSignature,
    });
    if (current.storageDirectory !== approved.storageDirectory || current.storageRoot !== approved.storageRoot || current.importMode !== approved.importMode ||
        JSON.stringify(current.attachmentRoots) !== JSON.stringify(approved.attachmentRoots)) {
      throw new Error('文库的导入设置已更改，请重新选择并确认。 / Library import settings changed. Select and approve them again.');
    }
  }

  async function approveSelectedFileAccess(details) {
    if (!await confirmImportSettings(details)) return null;
    // Re-read only strings first: a prompt-time change must not cause an
    // unreviewed network lookup even when the final canonical check rejects it.
    validateUnchangedSettings(details);
    const resolved = inspectLibraryDirectory(details.dataDirectory, {
      resolveFileAccess: true, expectedFileAccessSignature: details.fileAccessSignature,
    });
    if (comparable(resolved.storageRoot) !== comparable(details.storageRoot) ||
        JSON.stringify(resolved.attachmentRoots) !== JSON.stringify(details.attachmentRoots)) {
      if (!await confirmImportSettings(resolved)) return null;
    }
    validateUnchangedSettings(resolved);
    return resolved;
  }

  async function recover(error) {
    const answer = await dialog.showMessageBox({
      type: 'error', title: '无法打开原文库 / Library Unavailable',
      message: '没有创建空文库。请接回原磁盘后重试，或选择已有文库。 / No empty replacement was created. Reconnect the original disk or choose an existing library.',
      detail: error instanceof Error ? error.message : String(error),
      buttons: ['退出 / Quit', '选择已有文库 / Choose Existing'], defaultId: 0, cancelId: 0,
    });
    if (answer.response !== 1) return false;
    const selected = await selectExisting();
    if (!selected) return false;
    const resolved = await approveSelectedFileAccess(selected);
    if (!resolved) return false;
    // Keep the remembered profile when only its library is unavailable. Fall
    // back to the launch profile only when the remembered profile was missing.
    fs.mkdirSync(recoveryProfile, { recursive: true });
    persistLocation(recoveryProfile, resolved.dataDirectory, true, true, fileAccessPolicy(resolved));
    pending = null;
    return true;
  }

  function validateFileOperation(library, attachments = [], { metadataOnly = false } = {}) {
    if (!active?.approvedFileAccess) return;
    const onDisk = inspectLibraryDirectory(active.dataDirectory, {
      verifyIntegrity: false, resolveFileAccess: !metadataOnly, approvedFileAccess: active.approvedFileAccess,
    });
    if (comparable(onDisk.dataDirectory) !== comparable(active.dataDirectory)) throw new Error('Library directory changed.');
    assertApprovedFileAccess(onDisk, active.approvedFileAccess);
    const storageDirectory = library.settings.storageDir || path.join(active.dataDirectory, 'paperquay-data');
    assertFilesystemPath(storageDirectory);
    assertApprovedImportSettings({ storageDirectory, importMode: library.settings.importMode || 'copy' }, active.approvedFileAccess);
    // Metadata saves must still reject changed import policy, but must not
    // inspect attachment/PDF volumes or grant fresh canonical permissions.
    if (metadataOnly) return { storageRoot: active.approvedFileAccess.storageRoot, attachmentPaths: [] };
    const attachmentPaths = attachments.map((attachment) => {
      if (typeof attachment.storedPath !== 'string' || !path.isAbsolute(attachment.storedPath)) throw new Error('Invalid attachment path. No files were changed.');
      assertFilesystemPath(attachment.storedPath);
      return canonicalPath(attachment.storedPath);
    });
    const details = {
      storageDirectory,
      storageRoot: canonicalPath(storageDirectory),
      importMode: library.settings.importMode || 'copy',
      attachmentRoots: attachments.flatMap((attachment, index) => {
        const effective = effectiveRelativePath(storageDirectory, attachment.relativePath);
        return [path.dirname(attachmentPaths[index]), ...(effective ? [path.dirname(effective)] : [])];
      }),
    };
    assertApprovedFileAccess(details, active.approvedFileAccess);
    return { storageRoot: details.storageRoot, attachmentPaths };
  }

  async function authorizeCloudParsePath(library, pdfPath, cloud = true) {
    if (!active?.approvedFileAccess) return canonicalPath(pdfPath);
    validateFileOperation(library, library.papers.flatMap((paper) => paper.attachments));
    if (typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath)) throw new Error('Invalid cloud parsing PDF path.');
    const actual = canonicalPath(pdfPath);
    if (!cloud) {
      const relative = path.relative(comparable(canonicalPath(active.dataDirectory)), comparable(actual));
      if (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) return actual;
    }
    const approvedFiles = cloud ? approvedCloudFiles : approvedReadFiles;
    try { validateFileOperation(library, [{ storedPath: actual }]); return actual; }
    catch (error) {
      if (approvedFiles.has(comparable(actual))) return actual;
      const answer = await dialog.showMessageBox({
        type: 'warning', title: cloud ? '确认上传外部 PDF / Approve External PDF Upload' : '确认读取外部文件 / Approve External File Read',
        message: cloud ? '将此文件上传到云端解析服务？ / Upload this file to the cloud parsing service?' : '打开此文件？ / Open this file?',
        detail: `${JSON.stringify(actual)}\n\n此文件不在已批准的文库范围内。后续解析、笔记或 RAG 索引可能把正文写入当前文库及其共享位置。 / This file is outside the approved library roots. Subsequent parsing, notes or RAG indexing may save its contents in this library and its shared location.`,
        buttons: ['取消 / Cancel', cloud ? '上传此文件 / Upload This File' : '读取此文件 / Read This File'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (answer.response !== 1) throw error;
    }
    validateFileOperation(library, library.papers.flatMap((paper) => paper.attachments));
    if (comparable(canonicalPath(pdfPath)) !== comparable(actual)) throw new Error('Cloud parsing file changed during approval.');
    approvedFiles.add(comparable(actual));
    return actual;
  }

  function validateRestoreTarget(kind, target) {
    const actual = canonicalPath(target);
    if (!active?.approvedFileAccess) return actual;
    const root = kind === 'pdf' ? active.approvedFileAccess.storageRoot : path.join(canonicalPath(active.dataDirectory), '.mineru-cache');
    const relative = path.relative(comparable(root), comparable(actual));
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Restore target escapes approved root.');
    return actual;
  }

  async function approveSettingsChange(previous, next) {
    if (!active?.approvedFileAccess) return null;
    const storageDirectory = next.settings.storageDir;
    if (typeof storageDirectory !== 'string' || !path.isAbsolute(storageDirectory) || !['copy', 'move', 'keep'].includes(next.settings.importMode)) {
      throw new Error('Invalid PDF storage directory or import mode.');
    }
    if (storageDirectory === previous.settings.storageDir && next.settings.importMode === previous.settings.importMode) {
      validateFileOperation(previous, [], { metadataOnly: true });
      return null;
    }
    const attachments = previous.papers.flatMap((paper) => paper.attachments);
    const sources = validateFileOperation(previous, attachments);
    const expected = inspectLibraryDirectory(active.dataDirectory, {
      verifyIntegrity: false, inspectAttachmentRoots: true, resolveFileAccess: true, approvedFileAccess: active.approvedFileAccess,
    });
    const approved = active.approvedFileAccess;
    const policy = { ...approved, storageDirectory, storageRoot: canonicalPath(storageDirectory), importMode: next.settings.importMode };
    const result = await dialog.showMessageBox({
      type: 'warning', title: '确认修改文库设置 / Approve Library Settings Change',
      message: '应用新的 PDF 存储设置？ / Apply new PDF storage settings?',
      detail: `Destination: ${JSON.stringify(storageDirectory)}\nMode: ${policy.importMode}\n\n更改目录将复制现有受管文件。MOVE 导入将删除原文件；共享目录可能泄露文件。 / Changing directory copies existing managed files. MOVE imports remove originals; shared folders may expose files.`,
      buttons: ['取消 / Cancel', '应用 / Apply'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (result.response !== 1) throw new Error('Library settings change canceled.');
    validateUnchangedSettings(expected);
    if (canonicalPath(storageDirectory) !== policy.storageRoot) throw new Error('Storage destination changed during confirmation.');
    return {
      storageRoot: policy.storageRoot,
      sourcePaths: new Map(attachments.map((attachment, index) => [attachment.storedPath, sources.attachmentPaths[index]])),
      validateDestination(target) {
        const actual = canonicalPath(target);
        const relative = path.relative(comparable(policy.storageRoot), comparable(actual));
        if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('..' + path.sep)) throw new Error('Migration destination escapes approved storage root.');
        return actual;
      },
      commit(save) {
        // Both writes are synchronous; failures restore the previous policy.
        // A process/power failure between writes fails closed into recovery.
        persistLocation(active.profileDirectory, active.dataDirectory, false, false, policy);
        try { save(); }
        catch (error) {
          persistLocation(active.profileDirectory, active.dataDirectory, false, false, approved);
          throw error;
        }
        active = { ...active, approvedFileAccess: policy };
      },
    };
  }

  async function approveImportedAttachments(previous, attachments) {
    if (!active?.approvedFileAccess || !attachments.length) return null;
    validateFileOperation(previous, previous.papers.flatMap((paper) => paper.attachments));
    const oldPolicy = active.approvedFileAccess;
    const roots = new Set();
    for (const attachment of attachments) {
      try { validateFileOperation(previous, [attachment]); }
      catch {
        if (typeof attachment.storedPath !== 'string' || !path.isAbsolute(attachment.storedPath)) throw new Error('Invalid imported attachment path.');
        roots.add(path.dirname(canonicalPath(attachment.storedPath)));
      }
    }
    if (!roots.size) return null;
    const expected = inspectLibraryDirectory(active.dataDirectory, {
      verifyIntegrity: false, inspectAttachmentRoots: true, resolveFileAccess: true, approvedFileAccess: active.approvedFileAccess,
    });
    if (!await confirmAttachmentRoots([...roots].sort())) throw new Error('Keep-path import canceled.');
    validateUnchangedSettings(expected);
    const policy = { ...oldPolicy, attachmentRoots: [...new Set([...oldPolicy.attachmentRoots, ...roots])].sort() };
    // Re-resolve the selected files after the modal so links cannot silently
    // change the approved roots while the user is reviewing the prompt.
    assertApprovedFileAccess({ ...expected, attachmentRoots: attachments.map((item) => path.dirname(canonicalPath(item.storedPath))) }, policy);
    return { commit(save) {
      persistLocation(active.profileDirectory, active.dataDirectory, false, false, policy);
      try { save(); }
      catch (error) {
        persistLocation(active.profileDirectory, active.dataDirectory, false, false, oldPolicy);
        throw error;
      }
      active = { ...active, approvedFileAccess: policy };
    } };
  }

  return { resolve, rememberActive, status, selectExisting, activateSelected, recover, validateFileOperation, validateRestoreTarget, approveSettingsChange, approveImportedAttachments, authorizeCloudParsePath,
    authorizeLocalRead: (library, filePath) => authorizeCloudParsePath(library, filePath, false) };
}

module.exports = { REGISTRY_NAME, inspectLibraryDirectory, readRegistry, createLibraryLocationManager };
