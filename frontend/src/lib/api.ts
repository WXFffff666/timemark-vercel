import type { ApiResponse } from '@timemark/shared';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000/api' : '/api';
const SESSION_ID_KEY = 'timemark_session_id';

export const usesCookieAuth = () => !!localStorage.getItem(SESSION_ID_KEY);

/** 清除可能干扰 HttpOnly Cookie 认证的过期 Bearer */
export function clearStaleBearerTokens() {
  localStorage.removeItem('accessToken');
  localStorage.removeItem('refreshToken');
  sessionStorage.removeItem('accessToken');
  sessionStorage.removeItem('refreshToken');
}

const getTokens = () => {
  if (usesCookieAuth()) {
    return {
      accessToken: null as string | null,
      refreshToken: null as string | null,
      sessionId: localStorage.getItem(SESSION_ID_KEY),
    };
  }
  return {
    accessToken: localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken'),
    refreshToken: localStorage.getItem('refreshToken') || sessionStorage.getItem('refreshToken'),
    sessionId: null as string | null,
  };
};

const setAccessToken = (token: string) => {
  if (usesCookieAuth()) return;
  sessionStorage.setItem('accessToken', token);
};

async function refreshSession(refreshToken?: string | null): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(refreshToken ? { refreshToken } : {}),
    });
    if (!response.ok) return false;
    const data: ApiResponse<{ accessToken?: string }> = await response.json();
    if (!data.success) return false;
    if (data.data?.accessToken && !usesCookieAuth()) {
      setAccessToken(data.data.accessToken);
    }
    return true;
  } catch {
    return false;
  }
}

let isRefreshing = false;
let refreshPromise: Promise<boolean> | null = null;

async function request<T>(url: string, options?: RequestInit, retryCount = 0): Promise<T> {
  const { accessToken, refreshToken } = getTokens();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    ...options?.headers,
  };

  const response = await fetch(`${API_BASE}${url}`, { ...options, headers, credentials: 'include' });

  if (response.status === 401 && retryCount < 2) {
    if (retryCount === 0) {
      if (!isRefreshing) {
        isRefreshing = true;
        refreshPromise = refreshSession(refreshToken);
      }
      const refreshed = await refreshPromise;
      isRefreshing = false;
      refreshPromise = null;
      if (refreshed) {
        return request<T>(url, options, 1);
      }
    }

    if (retryCount <= 1) {
      clearStaleBearerTokens();
      return request<T>(url, options, 2);
    }

    localStorage.removeItem(SESSION_ID_KEY);
    throw new Error('HTTP 401: 登录已过期，请重新登录');
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}: ${response.statusText}`;
    let locked = false;
    let remainingSeconds = 0;
    let requiresTotp = false;
    let code: string | undefined;
    try {
      const errData = await response.json() as ApiResponse<unknown> & {
        remainingSeconds?: number;
        locked?: boolean;
        requiresTotp?: boolean;
        code?: string;
        details?: { fieldErrors?: Record<string, string[]> };
      };
      if (errData.error) message = errData.error;
      if (
        errData.details?.fieldErrors &&
        (message === 'Validation failed' || message === 'Invalid input' || message === '请求参数无效')
      ) {
        const detailText = Object.entries(errData.details.fieldErrors)
          .flatMap(([field, msgs]) => (msgs?.length ? [`${field}: ${msgs.join(', ')}`] : []))
          .join('；');
        if (detailText) message = detailText;
      }
      if (errData.locked) locked = true;
      if (typeof errData.remainingSeconds === 'number') remainingSeconds = errData.remainingSeconds;
      if (errData.requiresTotp) requiresTotp = true;
      if (errData.code) code = errData.code;
    } catch {
      // ignore
    }
    const err = new Error(message) as Error & {
      locked?: boolean;
      remainingSeconds?: number;
      requiresTotp?: boolean;
      code?: string;
    };
    err.locked = locked;
    err.remainingSeconds = remainingSeconds;
    if (requiresTotp) err.requiresTotp = true;
    if (code) err.code = code;
    throw err;
  }

  const data: ApiResponse<T> = await response.json();
  if (!data.success) throw new Error(data.error || 'Request failed');
  return data.data as T;
}

export const api = {
  get: <T>(url: string) => request<T>(url, { method: 'GET' }),
  post: <T>(url: string, body?: any) => request<T>(url, { method: 'POST', body: JSON.stringify(body) }),
  put: <T>(url: string, body?: any) => request<T>(url, { method: 'PUT', body: JSON.stringify(body) }),
  delete: <T>(url: string, body?: any) => request<T>(url, { method: 'DELETE', ...(body ? { body: JSON.stringify(body) } : {}) }),
  getRaw: async <T>(url: string): Promise<{ data: T; pagination?: Record<string, unknown> }> => {
    const { accessToken } = getTokens();
    const response = await fetch(`${API_BASE}${url}`, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Requested-With': 'XMLHttpRequest',
        ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (!json.success) throw new Error(json.error || 'Request failed');
    return { data: json.data as T, pagination: json.pagination };
  },
};

export interface AvailableChannel {
  id: number;
  type: string;
  name: string;
  config_method: string;
  is_active: boolean;
  last_test_result: 'success' | 'failed' | null;
  last_test_at: string | null;
  connection_status: string | null;
}

export function fetchAvailableChannels() {
  return api.get<AvailableChannel[]>('/channels/available');
}
