import { create } from 'zustand';
import { api } from '@/lib/api';
import { DEFAULT_TIMEZONE } from '@/lib/timezone-utils';

interface TimezoneState {
  timezone: string;
  loaded: boolean;
  load: () => Promise<void>;
  setTimezone: (tz: string) => Promise<void>;
}

export const useTimezoneStore = create<TimezoneState>((set) => ({
  timezone: DEFAULT_TIMEZONE,
  loaded: false,
  load: async () => {
    try {
      const config = await api.get<{ timezone?: string }>('/config');
      const tz = config?.timezone?.trim() || DEFAULT_TIMEZONE;
      set({ timezone: tz, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  setTimezone: async (tz: string) => {
    const value = tz.trim() || DEFAULT_TIMEZONE;
    set({ timezone: value });
    try {
      await api.post('/config', { timezone: value });
    } catch (error) {
      console.error('Failed to save timezone:', error);
      throw error;
    }
  },
}));
