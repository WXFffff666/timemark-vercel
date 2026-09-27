import { useEffect } from 'react';
import { Users, ChevronDown } from 'lucide-react';
import { useProfileStore } from '@/stores/profile.store';

/**
 * 全局档案切换器（D5，checkbox 70）。
 *
 * 与 TimezoneSelector 同一套外观 / 交互；选项来自 `GET /api/profiles?active=true`，
 * 手选结果写进 profile.store（localStorage 按设备持久化）。选择「全部档案」= 清除
 * 过滤，页面回到引入档案前的默认行为（与 url 省略 profileId 等价）。
 */
export function ProfileSwitcher() {
  const { profileId, profiles, load, setProfileId } = useProfileStore();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="relative group flex items-center">
      <Users className="absolute left-3 w-4 h-4 text-slate-400 group-hover:text-primary-500 transition-colors pointer-events-none z-10" aria-hidden />
      <select
        value={profileId ?? ''}
        onChange={(e) => setProfileId(e.target.value ? Number(e.target.value) : null)}
        className="appearance-none bg-white/40 dark:bg-black/30 hover:bg-white/60 dark:hover:bg-black/50 text-sm font-semibold text-slate-700 dark:text-slate-300 pl-9 pr-8 py-2 rounded-xl border border-white/20 dark:border-white/5 shadow-inner backdrop-blur-md transition-all duration-300 cursor-pointer outline-none focus:ring-2 focus:ring-primary-500/50 active:scale-95 max-w-[9rem] truncate"
        aria-label="切换档案"
      >
        <option value="">全部档案</option>
        {profiles.map((profile) => (
          <option key={profile.id} value={profile.id}>
            {profile.avatar_emoji ? `${profile.avatar_emoji} ` : ''}
            {profile.name}
          </option>
        ))}
      </select>
      <div className="absolute right-3 pointer-events-none">
        <ChevronDown className="w-4 h-4 text-slate-400 group-hover:text-primary-500 transition-colors" aria-hidden />
      </div>
    </div>
  );
}
