import { create } from 'zustand';
import { api } from '../lib/api';
import type { Event, CreateEventRequest } from '@timemark/shared';

interface EventState {
  events: Event[];
  loading: boolean;
  fetchEvents: () => Promise<void>;
  createEvent: (data: CreateEventRequest) => Promise<void>;
  updateEvent: (id: string, data: Partial<CreateEventRequest>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  deleteEventsBatch: (ids: string[]) => Promise<number>;
  testSendEvent: (id: string) => Promise<{ channelResults?: Record<string, { success: boolean; error?: string }>; status?: string }>;
}

export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  loading: false,

  fetchEvents: async () => {
    set({ loading: true });
    try {
      const events = await api.get<Event[]>('/events');
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
