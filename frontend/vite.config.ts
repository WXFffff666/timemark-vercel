import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite 8 (Rolldown) only accepts function-form `manualChunks`. The object form used before
// (`{ 'vendor-react': [...], 'vendor-motion': [...], 'vendor-charts': [...] }`) is invalid there,
// so the same three vendor groups are reproduced by matching each library's module family
// (including the runtime deps the object form used to pull into the same chunk).
const VENDOR_GROUPS: Array<{ name: string; packages: string[] }> = [
  { name: 'vendor-react', packages: ['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'] },
  { name: 'vendor-motion', packages: ['framer-motion', 'motion-dom', 'motion-utils', 'tslib'] },
  {
    name: 'vendor-charts',
    packages: ['recharts', 'victory-vendor', 'react-smooth', 'recharts-scale', 'react-is', 'lodash', 'eventemitter3', 'tiny-invariant', 'clsx'],
  },
];

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          const normalized = id.replace(/\\/g, '/');
          for (const group of VENDOR_GROUPS) {
            if (group.packages.some((pkg) => normalized.includes(`/node_modules/${pkg}/`))) {
              return group.name;
            }
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      // v2.41 R22：^/api/ 精确前缀——此前 '/api' 前缀把 /api-portal、/api-v1
      // 等页面路由也代理给 backend，backend 静态 fallback 返回 dist/index.html
      // （生产 bundle 引用 /assets/*），dev server 下 404 → ApiPortal 页 dev 白屏
      // （v2.30 建页起一直如此，SPA 内部导航不走网络所以没人发现）。
      '/api/': {
        target: process.env.VITE_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
});
