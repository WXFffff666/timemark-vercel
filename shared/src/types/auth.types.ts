export interface User {
  id: string;
  username: string;
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
  accessToken: string;
  refreshToken: string;
  user: User;
}
