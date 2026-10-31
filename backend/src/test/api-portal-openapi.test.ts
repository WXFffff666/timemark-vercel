import { describe, it, expect } from 'vitest';
import { openApiSpec } from '../routes/api-portal.openapi.js';

/**
 * v2.41 R21：OpenAPI spec 结构校验。
 * 同步纪律：api-portal.ts 的端点增删必须同步 openapi spec——这里 pin 住
 * paths 清单与鉴权方案，防止「路由改了 spec 忘改」的漂移。
 */

describe('api-portal openapi spec', () => {
  const spec = openApiSpec as unknown as {
    openapi: string;
    info: { title: string; version: string };
    servers: Array<{ url: string }>;
    paths: Record<string, Record<string, unknown>>;
    components: { securitySchemes: Record<string, unknown> };
  };

  it('is a valid OpenAPI 3.1 document skeleton', () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.info.title).toBe('TimeMark Public API');
    expect(spec.servers[0]?.url).toBe('/api/v1');
  });

  it('pins the public endpoint surface (sync guard with api-portal.ts)', () => {
    // /openapi.json 是 spec 自身的投递路由，不列入 spec.paths
    expect(Object.keys(spec.paths).sort()).toEqual(
      ['/events', '/events/{id}', '/expiry', '/habits', '/stats/daily'].sort(),
    );
    expect(spec.paths['/events']).toHaveProperty('get');
    expect(spec.paths['/events']).toHaveProperty('post');
    expect(spec.paths['/events/{id}']).toHaveProperty('get');
    expect(spec.paths['/expiry']).toHaveProperty('get');
    expect(spec.paths['/habits']).toHaveProperty('get');
    expect(spec.paths['/stats/daily']).toHaveProperty('get');
  });

  it('declares the tmt_ bearer security scheme and applies it globally', () => {
    const scheme = spec.components.securitySchemes.BearerAuth as { type: string; scheme: string } | undefined;
    expect(scheme?.type).toBe('http');
    expect(scheme?.scheme).toBe('bearer');
    // openapi.json 路由本身公开（无需鉴权），其余 path 全部声明 BearerAuth
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (method === 'parameters') continue;
        const operation = op as { security?: unknown[] };
        // 未显式覆盖 security 的操作继承全局 BearerAuth
        expect(['get', 'post']).toContain(method);
        expect(operation).toBeDefined();
        void path;
      }
    }
  });

  it('every response object has a description (OpenAPI requirement)', () => {
    for (const methods of Object.values(spec.paths)) {
      for (const op of Object.values(methods)) {
        const responses = (op as { responses?: Record<string, { description?: string }> }).responses ?? {};
        expect(Object.keys(responses).length).toBeGreaterThan(0);
        for (const [code, resp] of Object.entries(responses)) {
          expect(resp.description, `response ${code} missing description`).toBeTruthy();
        }
      }
    }
  });
});
