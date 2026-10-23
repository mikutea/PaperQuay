import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 4317, strictPort: true },
  preview: { host: '127.0.0.1', port: 4319, strictPort: true },
  // Keep the standalone client independent from the Electron app's PostCSS config.
  css: { postcss: { plugins: [] } },
  build: { target: ['es2022', 'safari15'], sourcemap: false },
});
