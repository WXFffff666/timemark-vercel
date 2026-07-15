import type { ApiResponse } from '@timemark/shared';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000/api' : '/api';

const getTokens = () => ({
  accessToken: localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken'),
  refreshToken: localStorage.getItem('refreshToken') || sessionStorage.getItem('refreshToken'),
  sessionId: localStorage.getItem('timemark_session_id'),
});

const setAccessToken = (token: string) => {
  const { sessionId } = getTokens();
  if (sessionId) {
    localStorage.setItem('accessToken', token);
  } else {
    sessionStorage.setItem('accessToken', token);
  }
};

async function refreshAccessToken(refreshToken: string): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!response.ok) return null;

    const data: ApiResponse<{ accessToken: string }> = await response.json();
    if (!data.success) return null;

    return data.data.accessToken;
  } catch {
    return null;
  }
}

let isRefreshing = false;
let refreshPromise: Promise<string | null> | null = null;

async function request<T>(url: string, options?: RequestInit, retryAfterRefresh = false): Promise<T> {
  const { accessToken, refreshToken, sessionId } = getTokens();

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    'X-Requested-With': 'XMLHttpRequest',
    ...(accessToken && { Authorization: `Bearer ${accessToken}` }),
    ...options?.headers,
  };

  const response = await fetch(`${API_BASE}${url}`, { ...options, headers });

  // If 401 and not already retried, try to refresh token
  if (response.status === 401 && !retryAfterRefresh && refreshToken) {
    // Prevent multiple simultaneous refresh attempts
    if (!isRefreshing) {
      isRefreshing = true;
      refreshPromise = refreshAccessToken(refreshToken);
    }

    const newAccessToken = await refreshPromise;
    isRefreshing = false;

    if (newAccessToken) {
      // Store new token and retry
      setAccessToken(newAccessToken);
      return request<T>(url, options, true);
    }

    // Refresh failed, clear tokens
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    sessionStorage.removeItem('accessToken');
    sessionStorage.removeItem('refreshToken');
    localStorage.removeItem('timemark_session_id');

    throw new Error('HTTP 401: Token expired and refresh failed');
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}: ${response.statusText}`;
    try {
      const errData = await response.json() as ApiResponse<unknown> & {
        remainingSeconds?: number;
        locked?: boolean;
      };
      if (errData.error) {
        message = errData.error;
        if (errData.remainingSeconds && errData.remainingSeconds > 0) {
          message += `（剩余 ${errData.remainingSeconds} 秒）`;
        }
      }
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }

  const data: ApiResponse<T> = await response.json();

  if (!data.success) {
    throw new Error(data.error || 'Request failed');
  }

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

// Channel availability types
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