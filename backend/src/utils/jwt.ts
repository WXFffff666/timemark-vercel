import { sign, verify } from 'hono/jwt';

const DEFAULT_JWT_SECRET = 'change-this-secret-in-production';



// 安全检查函数
export function isSecureSecret(): boolean {
  const current = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
  return current !== DEFAULT_JWT_SECRET && current.length >= 32;
}

export async function generateAccessToken(userId: string, secret?: string, rememberMe: boolean = false): Promise<string> {
  const expiresIn = rememberMe ? 60 * 60 : 15 * 60;
  return sign({ userId, exp: Math.floor(Date.now() / 1000) + expiresIn }, secret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET);
}

export async function generateRefreshToken(userId: string, secret?: string): Promise<string> {
  return sign({ userId, exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60 }, secret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET);
}

export async function verifyToken(token: string, secret?: string): Promise<{ userId: string } | null> {
  try {
    const payload = await verify(token, secret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET, 'HS256');
    return { userId: payload.userId as string };
  } catch {
    return null;
  }
}
