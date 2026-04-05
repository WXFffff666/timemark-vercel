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
    deviceId = crypto.randomUUID();
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
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,

  login: async (username, password, rememberMe = false) => {
    const fingerprint = await getEnhancedFingerprint();
    const response = await api.post<any>('/auth/login', { 
      username, 
      password, 
      deviceFingerprint: fingerprint, 
      rememberMe 
    });
    
    // Store tokens based on rememberMe preference
    if (rememberMe) {
      // Use localStorage for persistent sessions
      localStorage.setItem('accessToken', response.accessToken);
      localStorage.setItem('refreshToken', response.refreshToken);
      if (response.sessionId) {
        localStorage.setItem(SESSION_ID_KEY, response.sessionId);
      }
      // Also save device fingerprint confirmation
      localStorage.setItem('timemark_persistent_login', 'true');
    } else {
      // Use sessionStorage for session-only login
      sessionStorage.setItem('accessToken', response.accessToken);
      sessionStorage.setItem('refreshToken', response.refreshToken);
      localStorage.removeItem('timemark_persistent_login');
    }
    
    set({ user: response.user, isAuthenticated: true });
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
      set({ user: null, isAuthenticated: false });
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
    
    if (accessToken) {
      try {
        const user = await api.get<User>('/auth/session');
        set({ user, isAuthenticated: true });
        return;
      } catch (error: any) {
        // Token expired, try to refresh
        if (refreshToken && (error.message?.includes('401') || error.message?.includes('expired'))) {
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
            set({ user, isAuthenticated: true });
            return;
          } catch (refreshError) {
            console.error('Token refresh failed:', refreshError);
          }
        }
        
        // Clear invalid tokens
        localStorage.removeItem('accessToken');
        localStorage.removeItem('refreshToken');
        localStorage.removeItem(SESSION_ID_KEY);
        localStorage.removeItem('timemark_persistent_login');
        sessionStorage.removeItem('accessToken');
        sessionStorage.removeItem('refreshToken');
      }
    }
    
    set({ user: null, isAuthenticated: false });
  },
}));