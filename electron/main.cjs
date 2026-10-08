const path = require('node:path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const { createBackend } = require('./backend.cjs');
const { createLibraryLocationManager } = require('./libraryLocation.cjs');
const { createWindowSaveBarrier } = require('./windowSaveBarrier.cjs');
const { attachRendererTrust, assertTrustedRenderer } = require('./rendererTrust.cjs');
const trustedContents = new WeakSet();
const {
  registerLocalPdfProtocol,
  registerLocalPdfProtocolScheme,
} = require('./localPdfProtocol.cjs');

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
let backend = null;
let quitRequested = false;
const windowSaveBarrier = createWindowSaveBarrier({
  dialog,
  continueClose: (window) => { if (quitRequested) app.quit(); else window.close(); },
  cancelClose: () => { quitRequested = false; },
});
const libraryLocation = createLibraryLocationManager({
  app, dialog,
  restart: () => {
    setImmediate(() => { app.relaunch(); app.quit(); });
  },
});
let libraryLocationError = null;

// Chromium's default session must see the restored profile before readiness.
// Restoring only the backend location after ready is too late for session data.
try {
  libraryLocation.resolve();
} catch (error) {
  libraryLocationError = error;
}

registerLocalPdfProtocolScheme();

function getBackend() {
  if (!backend) {
    backend = createBackend({ app, libraryLocation });
  }

  return backend;
}

function getAppIconPath() {
  const iconFileName = process.platform === 'win32' ? 'icon.ico' : 'icon.png';
  const iconRoot = app.isPackaged ? 'dist' : 'public';

  return path.join(__dirname, '..', iconRoot, iconFileName);
}

function shouldIgnoreRendererConsoleMessage(level, message) {
  return (
    level === 'info' &&
    /^Warning: (Bad value, for custom key|TT: undefined function)/.test(message)
  );
}

function createWindow() {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 720,
    title: 'PaperQuay',
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    icon: getAppIconPath(),
    backgroundColor: '#eef2f8',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
  windowSaveBarrier.attach(mainWindow);

  if (isDev) {
    mainWindow.webContents.on('console-message', (event) => {
      const message = String(event.message ?? '');

      if (shouldIgnoreRendererConsoleMessage(event.level, message)) {
        return;
      }

      const source = event.sourceId ? `${event.sourceId}:${event.lineNumber}` : `line ${event.lineNumber ?? '?'}`;
      console.log(`[renderer:${event.level ?? 'info'}] ${message} (${source})`);
    });

    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.error('[renderer] process gone', details);
    });

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedUrl) => {
      console.error(`[renderer] failed to load ${validatedUrl}: ${errorCode} ${errorDescription}`);
    });
  }

  trustedContents.add(mainWindow.webContents);
  attachRendererTrust(mainWindow.webContents, (url) => shell.openExternal(url));

  if (isDev) {
    void mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

ipcMain.handle('paperquay:invoke', async (event, command, args) => {
  assertTrustedRenderer(event, trustedContents);
  if (command === 'app_window_save_ready') return windowSaveBarrier.ready(event.sender);
  if (command === 'app_window_save_complete') return windowSaveBarrier.complete(event.sender, args);
  return getBackend().invoke(command, args ?? {}, event);
});

ipcMain.handle('paperquay:window-control', (event, action) => {
  assertTrustedRenderer(event, trustedContents);
  const targetWindow = BrowserWindow.fromWebContents(event.sender);

  if (!targetWindow) {
    return;
  }

  if (action === 'minimize') {
    targetWindow.minimize();
    return;
  }

  if (action === 'toggleMaximize') {
    if (targetWindow.isMaximized()) {
      targetWindow.unmaximize();
    } else {
      targetWindow.maximize();
    }
    return;
  }

  if (action === 'close') {
    targetWindow.close();
  }
});

app.whenReady().then(async () => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('dev.paperquay.app');
  }

  if (libraryLocationError) {
    // Native dialogs require ready. Persist the selected recovery location and
    // start a fresh process so it too resolves the profile before ready; never
    // open a backend/window against a late-switched Chromium session.
    if (await libraryLocation.recover(libraryLocationError)) app.relaunch();
    app.quit();
    return;
  }
  try {
    getBackend();
    libraryLocation.rememberActive();
  } catch (error) {
    backend?.close();
    backend = null;
    if (await libraryLocation.recover(error)) app.relaunch();
    app.quit();
    return;
  }
  registerLocalPdfProtocol((filePath) => getBackend().authorizeLocalRead(filePath));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}).catch((error) => {
  dialog.showErrorBox('PaperQuay 启动失败 / Startup Failed', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => { quitRequested = true; });

app.on('will-quit', () => {
  backend?.close();
});
