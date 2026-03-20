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
    const event = await api.post<Event>('/events', data);
    set({ events: [...get().events, event] });
  },

  updateEvent: async (id, data) => {
    await api.put(`/events/${id}`, data);
    await get().fetchEvents();
  },

  deleteEvent: async (id) => {
    await api.delete(`/events/${id}`);
    set({ events: get().events.filter(e => e.id !== id) });
  },
}));
