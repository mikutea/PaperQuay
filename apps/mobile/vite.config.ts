import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import {nativeLinkBuildPlugin} from './scripts/native-link-build.ts';

export default defineConfig({
  plugins: [react(),nativeLinkBuildPlugin(process.env.PAPERQUAY_NATIVE_LINK_SETTINGS)],
  server: { host: '127.0.0.1', port: 4317, strictPort: true },
  preview: { host: '127.0.0.1', port: 4319, strictPort: true },
  // Keep the standalone client independent from the Electron app's PostCSS config.
  css: { postcss: { plugins: [] } },
  build: { target: ['es2022', 'safari15'], sourcemap: false },
});
