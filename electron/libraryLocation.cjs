const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('./backend/nodeSqlite.cjs');

const REGISTRY_NAME = 'paperquay-library-locations.json';
const LIBRARY_FILE = 'paperquay-library.sqlite';

function comparable(directory) {
  const resolved = path.resolve(directory);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function inspectLibraryDirectory(directory, { allowProfileDirectory = false, verifyIntegrity = true } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('请选择包含 PaperQuay 文库数据库的完整目录。 / Select an existing PaperQuay library directory.');
  }
  const candidates = (allowProfileDirectory ? [directory, path.join(directory, 'PaperQuay')] : [directory])
    .filter((candidate) => fs.existsSync(path.join(candidate, LIBRARY_FILE)));
  if (candidates.length !== 1) {
    throw new Error(candidates.length > 1
      ? '此目录包含多个文库，请选择具体文库目录。 / Multiple libraries found; select the exact library folder.'
      : '没有找到 paperquay-library.sqlite。不会新建或覆盖文库。 / Library database not found. No library will be created or overwritten.');
  }
  const dataDirectory = fs.realpathSync(candidates[0]);
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
    return {
      dataDirectory,
      databasePath,
      storageDirectory,
      importMode,
      paperCount: Number(db.prepare('SELECT count(*) AS count FROM papers').get().count),
      attachmentCount: Number(db.prepare('SELECT count(*) AS count FROM attachments').get().count),
    };
  } finally {
    db.close();
  }
}

function readRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) return { version: 1, defaultProfileDirectory: '', libraries: [] };
  const value = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.libraries) || value.libraries.length > 100 ||
      typeof value.defaultProfileDirectory !== 'string' ||
      (value.defaultProfileDirectory && !path.isAbsolute(value.defaultProfileDirectory)) ||
      value.libraries.some((entry) => typeof entry?.profileDirectory !== 'string' || !path.isAbsolute(entry.profileDirectory) ||
        typeof entry?.dataDirectory !== 'string' || !path.isAbsolute(entry.dataDirectory))) {
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

function createLibraryLocationManager({ app, dialog, argv = process.argv, restart }) {
  const registryPath = path.join(app.getPath('appData'), app.isPackaged ? REGISTRY_NAME : 'paperquay-development-library-locations.json');
  const initialProfile = app.getPath('userData');
  const explicitProfile = argv.some((arg) => arg === '--user-data-dir' || arg.startsWith('--user-data-dir='));
  let active = null;
  let pending = null;
  let recoveryProfile = initialProfile;

  function resolve() {
    const registry = readRegistry(registryPath);
    const profileDirectory = !explicitProfile && registry.defaultProfileDirectory
      ? registry.defaultProfileDirectory : initialProfile;
    const entry = registry.libraries.find((item) => comparable(item.profileDirectory) === comparable(profileDirectory));
    if (entry) {
      if (!fs.existsSync(profileDirectory)) {
        throw new Error(`原用户配置目录无法访问：${profileDirectory}\nProfile is unavailable. No empty replacement was created.`);
      }
      // Preserve Chromium settings even if only the external library is lost.
      // This runs before ready, including when validation below throws.
      recoveryProfile = profileDirectory;
      app.setPath('userData', profileDirectory);
      const details = inspectLibraryDirectory(entry.dataDirectory, { verifyIntegrity: false });
      active = { profileDirectory, ...details, registered: true };
    } else {
      if (!explicitProfile && registry.defaultProfileDirectory) throw new Error('默认文库记录不完整。 / The default library record is incomplete.');
      recoveryProfile = profileDirectory;
      app.setPath('userData', profileDirectory);
      active = { profileDirectory, dataDirectory: path.join(profileDirectory, 'PaperQuay'), registered: false };
    }
    return { ...active };
  }

  function persistLocation(profileDirectory, dataDirectory, makeDefault, allowRecovery = false) {
    let registry;
    try { registry = readRegistry(registryPath); }
    catch (error) {
      if (!allowRecovery) throw error;
      registry = { version: 1, defaultProfileDirectory: '', libraries: [] };
    }
    const key = comparable(profileDirectory);
    const previous = registry.libraries.find((entry) => comparable(entry.profileDirectory) === key);
    if (!previous && registry.libraries.length >= 100) {
      throw new Error('已达到文库配置数量上限，原记录未更改。 / Library profile limit reached. Existing records were preserved.');
    }
    if (previous && comparable(previous.dataDirectory) === comparable(dataDirectory) &&
        (!makeDefault || comparable(registry.defaultProfileDirectory || profileDirectory) === key) && registry.defaultProfileDirectory) return;
    registry.libraries = registry.libraries.filter((entry) => comparable(entry.profileDirectory) !== key);
    registry.libraries.push({ profileDirectory, dataDirectory });
    if (makeDefault || !registry.defaultProfileDirectory) registry.defaultProfileDirectory = profileDirectory;
    writeRegistry(registryPath, registry);
  }

  function rememberActive({ makeDefault = false } = {}) {
    if (!active) throw new Error('No active library location.');
    // Ordinary launches only remember a pointer. Full integrity scans belong
    // to the explicit existing-library selection/recovery flow, not startup.
    const details = inspectLibraryDirectory(active.dataDirectory, { verifyIntegrity: false });
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
    if (comparable(details.dataDirectory) === comparable(fs.realpathSync(current.dataDirectory))) {
      pending = null;
      return { unchanged: true, ...current };
    }
    if (!await confirmImportSettings(details)) return { canceled: true };
    validateUnchangedSettings(details);
    persistLocation(current.profileDirectory, details.dataDirectory, true);
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
    const answer = await dialog.showMessageBox({
      type: 'question',
      title: '切换文库并重启 / Switch Library and Restart',
      message: `打开已有文库（${details.paperCount} 篇）？ / Open existing library (${details.paperCount} papers)?`,
      detail: `${details.dataDirectory}\n\n此文库自带的后续 PDF 导入设置 / This library's settings for FUTURE PDF imports:\n存储目录 / Destination: ${details.storageDirectory}\n导入方式 / Mode: ${modeDescription}\n\n仅在信任该目录和导入方式时继续；复制或移动到共享目录可能向他人暴露文件。 / Continue only if you trust this destination and mode. Copying or moving files into shared locations may expose them to others.\n\n请先保存编辑内容并关闭使用此文库的其他实例。本次切换不会复制、合并或覆盖任一文库。 / Save edits and close other instances. This switch does not copy, merge or overwrite either library.`,
      buttons: ['取消 / Cancel', '信任这些导入设置并重启 / Trust Import Settings and Restart'], defaultId: 0, cancelId: 0,
      noLink: true,
    });
    return answer.response === 1;
  }

  function validateUnchangedSettings(approved) {
    const current = inspectLibraryDirectory(approved.dataDirectory);
    if (current.storageDirectory !== approved.storageDirectory || current.importMode !== approved.importMode) {
      throw new Error('文库的导入设置已更改，请重新选择并确认。 / Library import settings changed. Select and approve them again.');
    }
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
    if (!await confirmImportSettings(selected)) return false;
    validateUnchangedSettings(selected);
    // Keep the remembered profile when only its library is unavailable. Fall
    // back to the launch profile only when the remembered profile was missing.
    fs.mkdirSync(recoveryProfile, { recursive: true });
    persistLocation(recoveryProfile, selected.dataDirectory, true, true);
    pending = null;
    return true;
  }

  return { resolve, rememberActive, status, selectExisting, activateSelected, recover };
}

module.exports = { REGISTRY_NAME, inspectLibraryDirectory, readRegistry, createLibraryLocationManager };
