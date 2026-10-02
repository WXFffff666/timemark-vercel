import { sign, verify } from 'hono/jwt';
import { SESSION_TTL } from './session-ttl.js';

const DEFAULT_JWT_SECRET = 'change-this-secret-in-production';
const DEV_ONLY_SECRET = DEFAULT_JWT_SECRET;

function isProductionEnv(): boolean {
  return !!(process.env.VERCEL || process.env.NODE_ENV === 'production');
}

function resolveJwtSecret(secret?: string): string {
  const resolved = secret || process.env.JWT_SECRET || (isProductionEnv() ? undefined : DEV_ONLY_SECRET);
  if (!resolved) {
    throw new Error('JWT_SECRET must be set in production (>= 32 characters)');
  }
  if (isProductionEnv() && (resolved === DEFAULT_JWT_SECRET || resolved.length < 32)) {
    throw new Error('JWT_SECRET must be a secure random value (>= 32 characters) in production');
  }
  return resolved;
}

// 安全检查函数
export function isSecureSecret(): boolean {
  const current = process.env.JWT_SECRET;
  return !!current && current !== DEFAULT_JWT_SECRET && current.length >= 32;
}

export type TokenType = 'access' | 'refresh';

export interface TokenPayload {
  userId: string;
  sessionToken?: string;
  /** Absent on tokens minted before this claim existed; see verifyToken(). */
  typ?: TokenType;
  /**
   * Whether the session was created with "stay signed in". Carried on the refresh
   * token so `/refresh` reads the mode instead of re-deriving it from the remaining
   * lifetime — that re-derivation silently downgraded a 30-day session once it had
   * under 24h left. Absent on pre-existing tokens; treated as `false` (the safe
   * direction: degrade to a session cookie rather than silently extend).
   */
  rememberMe?: boolean;
}

export async function generateAccessToken(
  userId: string,
  sessionToken?: string,
  rememberMe: boolean = false,
  secret?: string,
): Promise<string> {
  const expiresIn = rememberMe ? SESSION_TTL.accessRememberSeconds : SESSION_TTL.accessShortSeconds;
  const payload: Record<string, unknown> = {
    userId,
    typ: 'access',
    exp: Math.floor(Date.now() / 1000) + expiresIn,
  };
  if (sessionToken) payload.sessionToken = sessionToken;
  return sign(payload, resolveJwtSecret(secret));
}

export async function generateRefreshToken(
  userId: string,
  sessionToken?: string,
  rememberMe: boolean = false,
  secret?: string,
): Promise<string> {
  const payload: Record<string, unknown> = {
    userId,
    typ: 'refresh',
    rememberMe,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL.refreshCookieSeconds,
  };
  if (sessionToken) payload.sessionToken = sessionToken;
  return sign(payload, resolveJwtSecret(secret));
}

export async function verifyToken(
  token: string,
  secret?: string,
  expectedType?: TokenType,
): Promise<TokenPayload | null> {
  try {
    const payload = await verify(token, resolveJwtSecret(secret), 'HS256');
    if (expectedType) {
      // A token minted before the typ claim existed carries no typ. Treat it as an access
      // token only, so already-issued cookies keep working until they expire while a legacy
      // refresh token is rejected at /refresh and the user simply logs in again.
      const actualType = payload.typ === undefined ? 'access' : payload.typ;
      if (actualType !== expectedType) return null;
    }
    return {
      userId: payload.userId as string,
      sessionToken: payload.sessionToken as string | undefined,
      typ: payload.typ as TokenType | undefined,
      rememberMe: payload.rememberMe === true,
    };
  } catch {
    return null;
  }
}
