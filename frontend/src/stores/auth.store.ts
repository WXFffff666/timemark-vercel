import { create } from 'zustand';
import { api } from '../lib/api';
import type { User } from '@timemark/shared';

const SESSION_ID_KEY = 'timemark_session_id';
const DEVICE_ID_COOKIE = '__timemark_device_id';

let cachedFingerprint: string | null = null;

// Enhanced device fingerprint that works better with AD Guard and similar blockers
async function getEnhancedFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  // Try to get existing device ID from cookie first
  let deviceId = document.cookie
    .split('; ')
    .find(row => row.startsWith(`${DEVICE_ID_COOKIE}=`))
    ?.split('=')[1];

  // Try localStorage as fallback
  if (!deviceId) {
    deviceId = localStorage.getItem('timemark_device_id') || undefined;
  }

  // Try sessionStorage as another fallback
  if (!deviceId) {
    deviceId = sessionStorage.getItem('timemark_device_id') || undefined;
  }

  // Generate new ID if none exists
  if (!deviceId) {
    deviceId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
          const r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
    // Try to persist with multiple fallbacks
    try {
      localStorage.setItem('timemark_device_id', deviceId);
    } catch {
      try {
        sessionStorage.setItem('timemark_device_id', deviceId);
      } catch {
        // Last resort: cookie (may be blocked by AD Guard)
        const maxAge = 365 * 24 * 3600;
        document.cookie = `${DEVICE_ID_COOKIE}=${deviceId}; Max-Age=${maxAge}; Path=/; SameSite=Lax`;
      }
    }
  }

  // Also create a more complex fingerprint from browser characteristics
  const fingerprintComponents = [
    navigator.userAgent,
    navigator.language,
    screen.colorDepth,
    `${screen.width}x${screen.height}`,
    new Date().getTimezoneOffset(),
    !!window.sessionStorage,
    !!window.localStorage,
    navigator.hardwareConcurrency || 'unknown',
    navigator.platform,
  ].join('|');

  // Simple hash of browser characteristics
  let hash = 0;
  for (let i = 0; i < fingerprintComponents.length; i++) {
    const char = fingerprintComponents.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }

  const browserHash = Math.abs(hash).toString(16);
  cachedFingerprint = `${browserHash}_${deviceId.slice(0, 8)}`;
  
  return cachedFingerprint;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  mustChangePassword: boolean;
  setUser: (user: User | null) => void;
  login: (username: string, password: string, rememberMe?: boolean, extras?: { turnstileToken?: string; totpCode?: string }) => Promise<{ mustChangePassword: boolean }>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearMustChangePassword: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  mustChangePassword: sessionStorage.getItem('mustChangePassword') === 'true',

  setUser: (user) => set({ user }),
  clearMustChangePassword: () => {
    sessionStorage.removeItem('mustChangePassword');
    set({ mustChangePassword: false });
  },

  login: async (username, password, rememberMe = false, extras = {}) => {
    console.log('[AuthStore] Login called');
    const fingerprint = await getEnhancedFingerprint();
    const response = await api.post<any>('/auth/login', { 
      username, 
      password, 
      deviceFingerprint: fingerprint, 
      rememberMe,
      turnstileToken: extras.turnstileToken,
      totpCode: extras.totpCode,
    });
    
    console.log('[AuthStore] Login response:', { hasAccessToken: !!response.accessToken, hasUser: !!response.user });
    
    // Prefer HttpOnly cookies — avoid persisting JWT in localStorage
    if (response.authMode === 'cookie') {
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      sessionStorage.removeItem('accessToken');
      sessionStorage.removeItem('refreshToken');
      if (response.sessionId) {
        localStorage.setItem(SESSION_ID_KEY, response.sessionId);
      }
      if (rememberMe) {
        localStorage.setItem('timemark_persistent_login', 'true');
      } else {
        localStorage.removeItem('timemark_persistent_login');
      }
    } else if (rememberMe) {
      localStorage.setItem('accessToken', response.accessToken);
      localStorage.setItem('refreshToken', response.refreshToken);
      if (response.sessionId) {
        localStorage.setItem(SESSION_ID_KEY, response.sessionId);
      }
      localStorage.setItem('timemark_persistent_login', 'true');
    } else {
      sessionStorage.setItem('accessToken', response.accessToken);
      sessionStorage.setItem('refreshToken', response.refreshToken);
      localStorage.removeItem('timemark_persistent_login');
    }
    
    console.log('[AuthStore] Setting isAuthenticated: true');
    const mustChangePassword = !!response.mustChangePassword;
    if (mustChangePassword) {
      sessionStorage.setItem('mustChangePassword', 'true');
    }
    set({ user: response.user, isAuthenticated: true, isLoading: false, mustChangePassword });
    console.log('[AuthStore] Login complete, isAuthenticated should be true now');
    return { mustChangePassword };
  },

  logout: async () => {
    const sessionId = localStorage.getItem(SESSION_ID_KEY);
    try {
      await api.post('/auth/logout', { sessionId });
    } finally {
      // Clear all storage
      localStorage.removeItem('accessToken');
      localStorage.removeItem('refreshToken');
      localStorage.removeItem(SESSION_ID_KEY);
      localStorage.removeItem('timemark_persistent_login');
      sessionStorage.removeItem('accessToken');
      sessionStorage.removeItem('refreshToken');
      sessionStorage.removeItem('lastPath');
      sessionStorage.removeItem('mustChangePassword');
      set({ user: null, isAuthenticated: false, isLoading: false, mustChangePassword: false });
    }
  },

  checkAuth: async () => {
    // Check for persistent login flag first
    const isPersistentLogin = localStorage.getItem('timemark_persistent_login') === 'true';
    
    // Get tokens from appropriate storage
    let accessToken = localStorage.getItem('accessToken');
    let refreshToken = localStorage.getItem('refreshToken');
    
    // If not in localStorage, check sessionStorage
    if (!accessToken) {
      accessToken = sessionStorage.getItem('accessToken');
      refreshToken = sessionStorage.getItem('refreshToken');
    }
    
    // Check for session ID (persistent login indicator)
    const sessionId = localStorage.getItem(SESSION_ID_KEY);
    
    // 超时保护：如果 checkAuth 超过 5 秒还没完成，使用缓存用户
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Auth check timeout')), 5000)
    );
    
    if (accessToken) {
      try {
        // 使用 Promise.race 实现超时
        const user = await Promise.race([
          api.get<User>('/auth/session'),
          timeoutPromise
        ]);
        // Cache user for offline/fallback
        localStorage.setItem('cachedUser', JSON.stringify(user));
        sessionStorage.setItem('cachedUser', JSON.stringify(user));
        set({ user, isAuthenticated: true, isLoading: false });
        return;
      } catch (error: any) {
        // 检查是否是超时
        const isTimeout = error.message?.includes('timeout');
        
        // 如果是超时，尝试使用缓存用户
        if (isTimeout) {
          const storedUser = localStorage.getItem('cachedUser') || sessionStorage.getItem('cachedUser');
          if (storedUser) {
            try {
              set({ user: JSON.parse(storedUser), isAuthenticated: true, isLoading: false });
              return;
            } catch {}
          }
        }
        // Only clear tokens on specific auth errors, not network errors
        const errorMsg = error.message || '';
        const isAuthError = errorMsg.includes('401') || 
                          errorMsg.includes('403') || 
                          errorMsg.includes('Token expired') || 
                          errorMsg.includes('expired') ||
                          errorMsg.includes('Unauthorized') ||
                          errorMsg.includes('Invalid');
        
        // Token expired or invalid, try to refresh
        if (refreshToken && isAuthError) {
          try {
            const refreshResponse = await api.post<any>('/auth/refresh', { refreshToken });
            
            // Store new access token in the same storage as before
            if (sessionId || isPersistentLogin) {
              localStorage.setItem('accessToken', refreshResponse.accessToken);
            } else {
              sessionStorage.setItem('accessToken', refreshResponse.accessToken);
            }
            
            // Re-verify with new token
            const user = await api.get<User>('/auth/session');
            set({ user, isAuthenticated: true, isLoading: false });
            return;
          } catch (refreshError) {
            console.error('Token refresh failed:', refreshError);
            // Only clear tokens if refresh also fails
            localStorage.removeItem('accessToken');
            localStorage.removeItem('refreshToken');
            localStorage.removeItem(SESSION_ID_KEY);
            localStorage.removeItem('timemark_persistent_login');
            sessionStorage.removeItem('accessToken');
            sessionStorage.removeItem('refreshToken');
          }
        }
        
        // For non-auth errors (network issues, server errors), don't clear tokens
        // Just mark as not authenticated temporarily
        if (!isAuthError) {
          // Network error or server error - keep the user logged in
          // The tokens are still valid, just the request failed
          const storedUser = localStorage.getItem('cachedUser') || sessionStorage.getItem('cachedUser');
          if (storedUser) {
            try {
              set({ user: JSON.parse(storedUser), isAuthenticated: true, isLoading: false });
              return;
            } catch {}
          }
        }
      }
    } else {
      // HttpOnly cookie session (no token in storage)
      try {
        const user = await Promise.race([
          api.get<User>('/auth/session'),
          timeoutPromise,
        ]);
        localStorage.setItem('cachedUser', JSON.stringify(user));
        sessionStorage.setItem('cachedUser', JSON.stringify(user));
        set({ user, isAuthenticated: true, isLoading: false });
        return;
      } catch (error: any) {
        const errorMsg = error.message || '';
        const isAuthError = errorMsg.includes('401') || errorMsg.includes('Unauthorized');
        if (isAuthError) {
          try {
            await api.post('/auth/refresh', {});
            const user = await api.get<User>('/auth/session');
            set({ user, isAuthenticated: true, isLoading: false });
            return;
          } catch {
            // fall through
          }
        }
      }
    }
    
    set({ user: null, isAuthenticated: false, isLoading: false });
  },
}));