import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.paperquay.mobile',
  appName: 'PaperQuay',
  webDir: 'dist',
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { webContentsDebuggingEnabled: false },
  plugins: {
    // Standard fetch preserves cancellation, redirect rejection and incremental SSE chunks.
    // IdP, sync and model endpoints must allow the documented Capacitor WebView origins.
    CapacitorHttp: { enabled: false },
    CapacitorSQLite: { iosDatabaseLocation: 'Library/CapacitorDatabase', iosIsEncryption: false, androidIsEncryption: false },
  },
};

export default config;
