import { sign, verify } from 'hono/jwt';

const DEFAULT_JWT_SECRET = 'change-this-secret-in-production';



// 安全检查函数
export function isSecureSecret(): boolean {
  const current = process.env.JWT_SECRET || DEFAULT_JWT_SECRET;
  return current !== DEFAULT_JWT_SECRET && current.length >= 32;
}

export interface TokenPayload {
  userId: string;
  sessionToken?: string;
}

export async function generateAccessToken(
  userId: string,
  sessionToken?: string,
  rememberMe: boolean = false,
  secret?: string,
): Promise<string> {
  const expiresIn = rememberMe ? 60 * 60 : 15 * 60;
  const payload: Record<string, unknown> = {
    userId,
    exp: Math.floor(Date.now() / 1000) + expiresIn,
  };
  if (sessionToken) payload.sessionToken = sessionToken;
  return sign(payload, secret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET);
}

export async function generateRefreshToken(userId: string, sessionToken?: string, secret?: string): Promise<string> {
  const payload: Record<string, unknown> = {
    userId,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  };
  if (sessionToken) payload.sessionToken = sessionToken;
  return sign(payload, secret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET);
}

export async function verifyToken(token: string, secret?: string): Promise<TokenPayload | null> {
  try {
    const payload = await verify(token, secret || process.env.JWT_SECRET || DEFAULT_JWT_SECRET, 'HS256');
    return {
      userId: payload.userId as string,
      sessionToken: payload.sessionToken as string | undefined,
    };
  } catch {
    return null;
  }
}
