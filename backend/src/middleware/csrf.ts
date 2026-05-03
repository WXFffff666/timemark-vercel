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

    // 如果没有 Origin 和 Referer，检查自定义头部
    if (!requestOrigin) {
      // 对于 API 调用，检查是否有 Authorization 头部（JWT 认证）
      const authHeader = c.req.header('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        // 有 JWT token，允许通过
        // 这是因为 JWT 本身已经提供了 CSRF 保护
        return next();
      }
      
      // 检查 Content-Type 是否为 application/json（API 调用）
      const contentType = c.req.header('Content-Type');
      if (contentType && contentType.includes('application/json')) {
        // JSON 请求通常来自 API 调用，允许通过
        return next();
      }
      
      // 没有认证信息，拒绝请求
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
