import { create } from 'zustand';
import { api } from '../lib/api';
import { useProfileStore } from './profile.store';
import type { Event, CreateEventRequest } from '@timemark/shared';

interface EventState {
  events: Event[];
  loading: boolean;
  fetchEvents: () => Promise<void>;
  createEvent: (data: CreateEventRequest) => Promise<void>;
  updateEvent: (id: string, data: Partial<CreateEventRequest>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  deleteEventsBatch: (ids: string[]) => Promise<number>;
  testSendEvent: (id: string) => Promise<{
    channelResults?: Record<string, { success: boolean; error?: string; recipients?: string[] }>;
    status?: string;
  }>;
}

export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  loading: false,

  fetchEvents: async () => {
    set({ loading: true });
    try {
      // 档案切换器（checkbox 70）：选中档案时按 `?profileId=` 过滤；「全部档案」
      //（null）保持裸 `/events`，与引入档案前的请求形状一致。
      const profileId = useProfileStore.getState().profileId;
      const events = await api.get<Event[]>(profileId ? `/events?profileId=${profileId}` : '/events');
      set({ events });
    } finally {
      set({ loading: false });
    }
  },

  createEvent: async (data) => {
    await api.post<Event>('/events', data);
    await get().fetchEvents();
  },

  updateEvent: async (id, data) => {
    await api.put(`/events/${id}`, data);
    await get().fetchEvents();
  },

  deleteEvent: async (id) => {
    await api.delete(`/events/${id}`);
    set({ events: get().events.filter(e => e.id !== id) });
  },

  deleteEventsBatch: async (ids) => {
    const result = await api.delete<{ deleted: number }>('/events/batch', { ids });
    set({ events: get().events.filter(e => !ids.includes(e.id)) });
    return result.deleted;
  },

  testSendEvent: async (id) => {
    return api.post(`/events/${id}/test-send`, {});
  },
}));
