import type { Context, Next } from 'hono';

/**
 * CSRF 保护中间件
 * 
 * 对于使用 JWT 认证的 SPA 应用，CSRF 风险较低（因为 token 存储在 localStorage），
 * 但为了额外安全，我们验证 Origin/Referer 头部。
 * 
 * 保护范围：
 * - POST, PUT, DELETE, PATCH 请求
 * - 排除 GET, HEAD, OPTIONS（幂等操作）
 */

// 允许的来源列表
const getAllowedOrigins = (): string[] => {
  const origins: string[] = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5173',  // Vite dev server
    'http://127.0.0.1:5173',
  ];

  // 添加环境变量中配置的 CORS_ORIGIN
  const corsOrigin = process.env.CORS_ORIGIN;
  if (corsOrigin) {
    if (corsOrigin === '*') {
      return ['*']; // 允许所有来源
    }
    origins.push(...corsOrigin.split(',').map(o => o.trim()));
  }

  return origins;
};

/**
 * 检查来源是否允许
 */
function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return false;
  }

  if (allowedOrigins.includes('*')) {
    return true;
  }

  return allowedOrigins.some(allowed => {
    // 精确匹配
    if (origin === allowed) return true;
    // 通配符匹配（如 *.example.com）
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      return origin.endsWith(domain);
    }
    return false;
  });
}

/**
 * CSRF 保护中间件
 */
export function csrfProtection() {
  const allowedOrigins = getAllowedOrigins();

  return async (c: Context, next: Next) => {
    // 只保护状态变更请求
    const method = c.req.method.toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return next();
    }

    // 获取 Origin 或 Referer
    const origin = c.req.header('Origin');
    const referer = c.req.header('Referer');
    
    // 提取来源域名
    let requestOrigin = origin;
    if (!requestOrigin && referer) {
      try {
        const url = new URL(referer);
        requestOrigin = url.origin;
      } catch {
        // 无效的 Referer
      }
    }

    // API Key 认证不受 CSRF 影响（API Key 不会被浏览器自动发送）
    const apiKeyHeader = c.req.header('X-API-Key');
    if (apiKeyHeader) {
      return next();
    }

    // 检查是否有自定义头部 X-Requested-With（浏览器跨域请求无法伪造自定义头部）
    const xRequestedWith = c.req.header('X-Requested-With');
    const hasCustomHeader = xRequestedWith === 'XMLHttpRequest';

    // 如果没有 Origin 和 Referer，需要额外验证
    if (!requestOrigin) {
      // JWT Bearer token 不再单独绕过 CSRF 保护
      // 必须同时具有自定义头部（证明请求来自合法客户端，而非浏览器自动发送）
      const authHeader = c.req.header('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ') && hasCustomHeader) {
        return next();
      }

      // 没有有效的 Origin/Referer 且没有自定义头部，拒绝请求
      return c.json(
        { success: false, error: 'Missing origin or authorization' },
        403
      );
    }

    // 验证来源
    if (!isOriginAllowed(requestOrigin, allowedOrigins)) {
      console.warn(`[CSRF] Blocked request from origin: ${requestOrigin}`);
      return c.json(
        { success: false, error: 'Origin not allowed' },
        403
      );
    }

    return next();
  };
}
