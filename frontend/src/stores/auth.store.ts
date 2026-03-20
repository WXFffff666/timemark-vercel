import { create } from 'zustand';
import { api } from '../lib/api';
import type { User, LoginResponse } from '@timemark/shared';
import { saveFingerprint, loadFingerprint, clearFingerprint } from '../lib/deviceStorage';

const SESSION_ID_KEY = 'timemark_session_id';
const DEVICE_ID_COOKIE = '__timemark_device_id';

let cachedFingerprint: string | null = null;

async function getDeviceFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  let id = document.cookie
    .split('; ')
    .find(row => row.startsWith(`${DEVICE_ID_COOKIE}=`))
    ?.split('=')[1];
  
  if (!id) {
    id = await loadFingerprint() || undefined;
  }
  
  if (!id) {
    id = crypto.randomUUID();
    const maxAge = 365 * 24 * 3600;
    document.cookie = `${DEVICE_ID_COOKIE}=${id}; Max-Age=${maxAge}; Path=/; SameSite=Strict; Secure`;
    await saveFingerprint(id);
  }
  
  cachedFingerprint = id;
  return id;
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
    const fingerprint = await getDeviceFingerprint();
    const response = await api.post<any>('/auth/login', { username, password, deviceFingerprint: fingerprint, rememberMe });
    
    if (rememberMe) {
      localStorage.setItem('accessToken', response.accessToken);
      if (response.sessionId) {
        localStorage.setItem(SESSION_ID_KEY, response.sessionId);
      }
    } else {
      sessionStorage.setItem('accessToken', response.accessToken);
    }
    set({ user: response.user, isAuthenticated: true });
  },

  logout: async () => {
    const sessionId = localStorage.getItem(SESSION_ID_KEY);
    try {
      await api.post('/auth/logout', { sessionId });
    } finally {
      localStorage.removeItem('accessToken');
      sessionStorage.removeItem('accessToken');
      localStorage.removeItem(SESSION_ID_KEY);
      set({ user: null, isAuthenticated: false });
    }
  },

  checkAuth: async () => {
    const sessionId = localStorage.getItem(SESSION_ID_KEY);
    const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
    
    if (token) {
      try {
        const user = await api.get<User>('/auth/session');
        set({ user, isAuthenticated: true });
        return;
      } catch {
        localStorage.removeItem('accessToken');
        sessionStorage.removeItem('accessToken');
        localStorage.removeItem(SESSION_ID_KEY);
      }
    }
    
    set({ user: null, isAuthenticated: false });
  },
}));
