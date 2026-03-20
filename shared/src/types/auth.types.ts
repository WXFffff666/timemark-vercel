export interface User {
  id: string;
  username: string;
  totpSecret: string | null;
  createdAt: string;
}

export interface Session {
  id: string;
  userId: string;
  token: string;
  deviceFingerprint: string;
  isTrusted: boolean;
  expiresAt: string;
}

export interface LoginRequest {
  username: string;
  password: string;
  deviceFingerprint?: string;
  rememberMe?: boolean;
}

export interface LoginResponse {
  requiresTOTP: boolean;
  tempToken?: string;
  accessToken?: string;
  refreshToken?: string;
  user?: User;
  trusted?: boolean;
}

export interface Verify2FARequest {
  tempToken: string;
  totpCode: string;
  trustDevice: boolean;
  deviceFingerprint?: string;
  rememberMe?: boolean;
}
