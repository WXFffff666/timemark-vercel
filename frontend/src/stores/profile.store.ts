import { create } from 'zustand';
import { api } from '@/lib/api';
import type { ProfileRecord } from '@timemark/shared';

/**
 * 全局档案切换器状态（D5，checkbox 70）。
 *
 * 选择「按设备持久化」（localStorage `timemark.profileId`），与 timezone.store 的
 * 「一个 zustand store + load/set」形状一致；区别只在于时区存服务端、档案选择存本机：
 * 同一个账号在手机 / 电脑上可以停在不同档案上，互不覆盖。
 *
 * `profileId === null` = 「全部档案」：所有依赖档案过滤的接口省略 `?profileId=`，
 * 与引入档案前的行为完全一致。选中的档案被删除或归档后，下一次 load() 会自动回退。
 */

const STORAGE_KEY = 'timemark.profileId';

function readStoredProfileId(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const id = Number(raw);
    return Number.isInteger(id) && id > 0 ? id : null;
  } catch {
    return null;
  }
}

interface ProfileState {
  /** 当前选中的档案 id；null = 全部档案 */
  profileId: number | null;
  profiles: ProfileRecord[];
  loaded: boolean;
  load: () => Promise<void>;
  setProfileId: (id: number | null) => void;
}

export const useProfileStore = create<ProfileState>((set) => ({
  profileId: readStoredProfileId(),
  profiles: [],
  loaded: false,

  load: async () => {
    try {
      const data = await api.get<ProfileRecord[]>('/profiles?active=true');
      const profiles = Array.isArray(data) ? data : [];
      set({ profiles, loaded: true });
      // 选中的档案已不存在（删除 / 归档）→ 回退「全部档案」，不让页面卡在空过滤上。
      const current = readStoredProfileId();
      if (current !== null && !profiles.some((p) => p.id === current)) {
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          /* storage unavailable */
        }
        set({ profileId: null });
      }
    } catch {
      set({ loaded: true });
    }
  },

  setProfileId: (id) => {
    const value = id === null || !Number.isInteger(id) || id <= 0 ? null : id;
    try {
      if (value === null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      /* storage unavailable: the in-memory selection still works this session */
    }
    set({ profileId: value });
  },
}));
