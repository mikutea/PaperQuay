import type { CapacitorConfig } from '@capacitor/cli';

// M1 validates the Web client. Native projects and secure storage are M2 work.
const config: CapacitorConfig = {
  appId: 'dev.paperquay.mobile',
  appName: 'PaperQuay',
  webDir: 'dist',
};

export default config;
