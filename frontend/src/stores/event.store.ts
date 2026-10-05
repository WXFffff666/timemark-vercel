import { create } from 'zustand';
import { api } from '../lib/api';
import { useProfileStore } from './profile.store';
import type { Event, CreateEventRequest } from '@timemark/shared';

interface EventState {
  events: Event[];
  loading: boolean;
  /** v2.27：最近一次加载失败的错误信息（成功加载后清空）；列表页据此渲染重试条 */
  error: string | null;
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

let inFlight: Promise<void> | null = null;

export const useEventStore = create<EventState>((set, get) => ({
  events: [],
  loading: false,
  error: null,

  // v2.27：in-flight 去重——Calendar/Todos/Dashboard 同屏先后调用只发一次请求；
  // 失败记入 error（此前静默吞掉，列表页渲染成"暂无事件"假空态）。
  fetchEvents: async () => {
    if (inFlight) return inFlight;
    set({ loading: true, error: null });
    inFlight = (async () => {
      try {
        // 档案切换器（checkbox 70）：选中档案时按 `?profileId=` 过滤；「全部档案」
        //（null）保持裸 `/events`，与引入档案前的请求形状一致。
        const profileId = useProfileStore.getState().profileId;
        const events = await api.get<Event[]>(profileId ? `/events?profileId=${profileId}&limit=200` : '/events?limit=200');
        set({ events });
      } catch (e) {
        set({ error: e instanceof Error ? e.message : '事件加载失败' });
      } finally {
        set({ loading: false });
        inFlight = null;
      }
    })();
    return inFlight;
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
