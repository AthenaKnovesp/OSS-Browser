import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: resolve('src/renderer'),
  plugins: [react()],
  clearScreen: false,
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    outDir: resolve('dist'),
    emptyOutDir: true,
    sourcemap: false,
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'antd', test: /[\\/]node_modules[\\/](antd|@ant-design)[\\/]/ },
            { name: 'state', test: /[\\/]node_modules[\\/](zustand|dayjs)[\\/]/ }
          ]
        }
      }
    }
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@renderer': resolve('src/renderer/src')
    }
  }
});
