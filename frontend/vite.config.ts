import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite 8 (Rolldown) only accepts function-form `manualChunks`. The object form used before
// (`{ 'vendor-react': [...], 'vendor-motion': [...], 'vendor-charts': [...] }`) is invalid there,
// so the same three vendor groups are reproduced by matching each library's module family
// (including the runtime deps the object form used to pull into the same chunk).
//
// v2.44 R29：新增 vendor-ui 基础组。实测（dist 反查）：真正的首屏拖累不是 clsx
//（它本就不在 charts），而是 **use-sync-external-store**——zustand 与 recharts
// 共用的依赖，未命中任何名单时被 rolldown 归入 charts chunk → 所有用 zustand
// 的页面（几乎全部）都 import charts → 408KB recharts 进首屏 preload。
// 显式归入基础组后 charts 只被 4 个图表 lazy 页引用，自然移出首屏。
const VENDOR_GROUPS: Array<{ name: string; packages: string[] }> = [
  { name: 'vendor-ui', packages: ['clsx', 'tailwind-merge', 'class-variance-authority', 'use-sync-external-store'] },
  { name: 'vendor-react', packages: ['react', 'react-dom', 'react-router', 'react-router-dom', 'scheduler'] },
  { name: 'vendor-motion', packages: ['framer-motion', 'motion-dom', 'motion-utils', 'tslib'] },
  {
    name: 'vendor-charts',
    packages: ['recharts', 'victory-vendor', 'react-smooth', 'recharts-scale', 'react-is', 'lodash', 'eventemitter3', 'tiny-invariant'],
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
          // v2.44 R29：命名 chunk 会被 rolldown 全部写进 index.html 的 modulepreload
          //（实测：新增 vendor-ui 立即出现在 preload）。因此 vendor-ui/react/motion
          // 保留命名（首屏真依赖），而 **charts 组不再命名**——让它做普通按需 chunk，
          // 只被 4 个图表 lazy 页拉取，408KB 不再进首屏 preload 链。
          for (const group of VENDOR_GROUPS) {
            if (group.name === 'vendor-charts') continue;
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
