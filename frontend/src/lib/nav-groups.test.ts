import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAV_ALL_LABEL_KEYS, NAV_ALL_PATHS, NAV_GROUPS, NAV_PRIMARY } from './nav-groups';

/**
 * 导航覆盖不变式。
 *
 * App.tsx 挂了 38 条路由，其中 8 条曾经没有任何入口：功能写完了、路由挂上了，
 * 用户却找不到（/today /ask /assistant /agent-console /data-health /cron-monitor /
 * /lunar-holidays /docker-migration），只能手敲地址。这个测试让"新增页面忘了加入口"
 * 变成一次失败，而不是上线后才发现。
 */

/** 公开路由不需要导航入口：登录页、分享/嵌入页、根重定向 */
const PUBLIC_ROUTES = new Set(['/login', '/', '/shared/:token', '/embed/:token', '/share/:token']);

function appRoutePaths(): string[] {
  const source = readFileSync(join(__dirname, '..', 'App.tsx'), 'utf8');
  return [...source.matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]);
}

describe('导航覆盖', () => {
  const routes = appRoutePaths();
  const protectedRoutes = routes.filter((r) => !PUBLIC_ROUTES.has(r));

  it('每一条受保护路由都有导航入口', () => {
    const missing = protectedRoutes.filter((r) => !NAV_ALL_PATHS.includes(r));
    expect(missing, `这些路由没有任何入口：${missing.join(', ')}`).toEqual([]);
  });

  it('导航里没有指向已删除路由的死链', () => {
    const dead = NAV_ALL_PATHS.filter((p) => !routes.includes(p));
    expect(dead, `导航指向了不存在的路由：${dead.join(', ')}`).toEqual([]);
  });

  it('入口不重复（同一路由只出现一次）', () => {
    const seen = new Set<string>();
    const dupes = NAV_ALL_PATHS.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
    expect(dupes, `重复入口：${dupes.join(', ')}`).toEqual([]);
  });

  it('导航总数与受保护路由数一致', () => {
    expect(NAV_ALL_PATHS.length).toBe(protectedRoutes.length);
  });

  it('按四组组织，每组都有 i18n 标题', () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual(['overview', 'reminders', 'life', 'system']);
    for (const group of NAV_GROUPS) {
      expect(group.labelKey, `分组 ${group.id} 缺少标题键`).toBeTruthy();
      expect(group.items.length, `分组 ${group.id} 是空的`).toBeGreaterThan(0);
    }
  });

  it('移动端底部栏主位保持克制：不超过 5 项，且全部来自导航', () => {
    // 底部栏塞不下 33 项；主位之外都进「更多」面板
    expect(NAV_PRIMARY.length).toBeLessThanOrEqual(5);
    for (const item of NAV_PRIMARY) {
      expect(NAV_ALL_PATHS).toContain(item.path);
    }
  });

  it('底部栏不能排满 33 项——超了就退到「更多」面板', () => {
    expect(NAV_PRIMARY.length).toBeLessThan(NAV_ALL_PATHS.length);
  });

  it('每个入口都有图标和文案键', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(item.labelKey, `${item.path} 缺少文案键`).toBeTruthy();
        expect(item.icon, `${item.path} 缺少图标`).toBeTruthy();
      }
    }
  });

  it('所有文案键在 zh / en 两种语言里都存在（否则界面上会直接显示键名）', async () => {
    const { zh } = await import('../i18n/resources/zh');
    const { en } = await import('../i18n/resources/en');
    const missingZh = NAV_ALL_LABEL_KEYS.filter((k) => !(k in zh));
    const missingEn = NAV_ALL_LABEL_KEYS.filter((k) => !(k in en));
    expect(missingZh, `zh 缺少：${missingZh.join(', ')}`).toEqual([]);
    expect(missingEn, `en 缺少：${missingEn.join(', ')}`).toEqual([]);
  });
});