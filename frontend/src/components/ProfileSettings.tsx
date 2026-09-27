import { useEffect, useState } from 'react';
import { Plus, Trash2, Pencil, Bell, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';
import { useProfileStore } from '@/stores/profile.store';
import type { ProfileRecord } from '@timemark/shared';

/**
 * 设置页「家庭档案」区块（D5，checkbox 70）。
 *
 * - 档案 CRUD：名称 / 称呼 / 类别（家人、宠物）/ 头像 emoji / 时区。
 *   「我」（kind='self'）由迁移创建，不可删除、类别不可改（服务端同样拒绝）。
 * - 通知路由：每个档案可勾选「提醒走哪些通知账户」；一个都不勾 = 未配置路由 =
 *   全部启用账户（后端 profile_channel_accounts 无行时的回退语义）。
 *
 * 与设置页其它区块一致：直接调用 api.*，反馈用 alert()，样式复用 glass-panel。
 */

interface AccountRow {
  id: number;
  type: string;
  name: string;
  is_active: boolean;
}

const KIND_LABELS: Record<string, string> = { self: '我', family: '家人', pet: '宠物' };

export function ProfileSettings() {
  const { profiles, load } = useProfileStore();

  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<ProfileRecord | null>(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', relation: '', kind: 'family', avatarEmoji: '', timezone: '' });

  const [routingProfile, setRoutingProfile] = useState<ProfileRecord | null>(null);
  const [routedIds, setRoutedIds] = useState<number[]>([]);
  const [routingLoading, setRoutingLoading] = useState(false);

  useEffect(() => {
    void load();
    api.get<AccountRow[]>('/config/accounts')
      .then((data) => setAccounts(Array.isArray(data) ? data : []))
      .catch(() => setAccounts([]));
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm({ name: '', relation: '', kind: 'family', avatarEmoji: '', timezone: '' });
    setShowForm(true);
  };

  const openEdit = (profile: ProfileRecord) => {
    setEditing(profile);
    setForm({
      name: profile.name,
      relation: profile.relation ?? '',
      kind: profile.kind === 'pet' ? 'pet' : 'family',
      avatarEmoji: profile.avatar_emoji ?? '',
      timezone: profile.timezone ?? '',
    });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      alert('档案名称不能为空');
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        name: form.name.trim(),
        relation: form.relation.trim() || null,
        kind: form.kind,
        avatarEmoji: form.avatarEmoji.trim() || null,
        timezone: form.timezone.trim() || null,
      };
      if (editing) {
        // 「我」的类别不可修改（服务端同样拒绝）—— PATCH 时不发送 kind
        if (editing.kind === 'self') delete payload.kind;
        await api.patch(`/profiles/${editing.id}`, payload);
      } else {
        await api.post('/profiles', payload);
      }
      setShowForm(false);
      setEditing(null);
      await load();
    } catch (error) {
      alert('保存失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (profile: ProfileRecord) => {
    if (!window.confirm(`确定删除档案「${profile.name}」？关联数据会保留，只是不再归属该档案。`)) return;
    try {
      await api.delete(`/profiles/${profile.id}`);
      if (routingProfile?.id === profile.id) setRoutingProfile(null);
      await load();
    } catch (error) {
      alert('删除失败: ' + (error instanceof Error ? error.message : '未知错误'));
    }
  };

  const openRouting = async (profile: ProfileRecord) => {
    setRoutingProfile(profile);
    setRoutedIds([]);
    setRoutingLoading(true);
    try {
      const data = await api.get<{ account_ids: number[] }>(`/profiles/${profile.id}/accounts`);
      setRoutedIds(Array.isArray(data?.account_ids) ? data.account_ids : []);
    } catch (error) {
      alert('读取通知路由失败: ' + (error instanceof Error ? error.message : '未知错误'));
      setRoutingProfile(null);
    } finally {
      setRoutingLoading(false);
    }
  };

  const toggleRouted = (accountId: number) => {
    setRoutedIds((prev) => (prev.includes(accountId) ? prev.filter((id) => id !== accountId) : [...prev, accountId]));
  };

  const handleSaveRouting = async () => {
    if (!routingProfile) return;
    setSaving(true);
    try {
      const data = await api.put<{ account_ids: number[] }>(`/profiles/${routingProfile.id}/accounts`, { accountIds: routedIds });
      setRoutedIds(Array.isArray(data?.account_ids) ? data.account_ids : routedIds);
      alert('通知路由已保存');
    } catch (error) {
      alert('保存通知路由失败: ' + (error instanceof Error ? error.message : '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="glass-panel rounded-3xl p-6 md:p-8" aria-labelledby="profiles-heading">
      <div className="flex justify-between items-start gap-4 mb-4">
        <div>
          <h2 id="profiles-heading" className="text-lg font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Bell size={18} aria-hidden /> 家庭档案
          </h2>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">
            为家人 / 宠物建立独立档案，页面可按档案筛选；每个档案可单独指定提醒走哪些通知账户。
          </p>
        </div>
        <button type="button" onClick={openCreate} className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 text-white text-sm font-semibold px-3 py-2 hover:bg-primary-500 transition">
          <Plus size={16} aria-hidden /> 新建档案
        </button>
      </div>

      <ul className="divide-y divide-white/10">
        {profiles.map((profile) => (
          <li key={profile.id} className="py-3 flex flex-wrap items-center gap-3">
            <span className="text-xl" aria-hidden>{profile.avatar_emoji || (profile.kind === 'pet' ? '🐾' : '👤')}</span>
            <span className="font-medium text-slate-800 dark:text-slate-200">{profile.name}</span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-white/40 dark:bg-black/30 text-slate-500">
              {KIND_LABELS[profile.kind] ?? profile.kind}{profile.relation ? ` · ${profile.relation}` : ''}
            </span>
            <span className="flex-1" />
            <button type="button" onClick={() => void openRouting(profile)} className="text-sm text-primary-600 hover:underline">
              通知路由
            </button>
            <button type="button" onClick={() => openEdit(profile)} className="inline-flex items-center gap-1 text-sm text-slate-600 dark:text-slate-300 hover:underline" aria-label={`编辑档案 ${profile.name}`}>
              <Pencil size={14} aria-hidden /> 编辑
            </button>
            {profile.kind !== 'self' && (
              <button type="button" onClick={() => void handleDelete(profile)} className="inline-flex items-center gap-1 text-sm text-red-600 hover:underline" aria-label={`删除档案 ${profile.name}`}>
                <Trash2 size={14} aria-hidden /> 删除
              </button>
            )}
          </li>
        ))}
      </ul>

      {showForm && (
        <div className="mt-4 rounded-2xl bg-white/40 dark:bg-black/20 p-4 space-y-3" role="group" aria-label={editing ? '编辑档案' : '新建档案'}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="text-sm">
              <span className="block mb-1 text-slate-600 dark:text-slate-300">名称</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} aria-label="档案名称" className="w-full rounded-xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-black/30 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-slate-600 dark:text-slate-300">称呼</span>
              <input value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })} placeholder="妈妈 / 儿子 …" aria-label="档案称呼" className="w-full rounded-xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-black/30 px-3 py-2" />
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-slate-600 dark:text-slate-300">类别</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} disabled={editing?.kind === 'self'} aria-label="档案类别" className="w-full rounded-xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-black/30 px-3 py-2">
                <option value="family">家人</option>
                <option value="pet">宠物</option>
              </select>
            </label>
            <label className="text-sm">
              <span className="block mb-1 text-slate-600 dark:text-slate-300">头像 emoji</span>
              <input value={form.avatarEmoji} onChange={(e) => setForm({ ...form, avatarEmoji: e.target.value })} placeholder="🐱" aria-label="档案头像" className="w-full rounded-xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-black/30 px-3 py-2" />
            </label>
            <label className="text-sm sm:col-span-2">
              <span className="block mb-1 text-slate-600 dark:text-slate-300">时区（可选，覆盖用户时区）</span>
              <input value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} placeholder="Asia/Shanghai" aria-label="档案时区" className="w-full rounded-xl border border-white/20 dark:border-white/10 bg-white/60 dark:bg-black/30 px-3 py-2" />
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" onClick={() => void handleSave()} disabled={saving} className="inline-flex items-center gap-1.5 rounded-xl bg-primary-600 text-white text-sm font-semibold px-4 py-2 hover:bg-primary-500 disabled:opacity-60">
              {saving && <Loader2 size={14} className="animate-spin" aria-hidden />} 保存
            </button>
            <button type="button" onClick={() => { setShowForm(false); setEditing(null); }} className="rounded-xl border border-white/20 px-4 py-2 text-sm">取消</button>
          </div>
        </div>
      )}

      {routingProfile && (
        <div className="mt-4 rounded-2xl bg-white/40 dark:bg-black/20 p-4" role="group" aria-label={`${routingProfile.name} 的通知路由`}>
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-200 mb-1">
            「{routingProfile.name}」的通知路由
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mb-3">
            勾选该档案提醒可用的通知账户；一个都不勾 = 未配置，回退为全部启用账户。
          </p>
          {routingLoading ? (
            <p className="text-sm text-slate-500">读取中…</p>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-slate-500">还没有通知账户，请先在「通知渠道」中配置。</p>
          ) : (
            <ul className="space-y-1 mb-3">
              {accounts.map((account) => (
                <li key={account.id}>
                  <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-300">
                    <input type="checkbox" checked={routedIds.includes(account.id)} onChange={() => toggleRouted(account.id)} aria-label={`路由到账户 ${account.name}`} />
                    {account.name}（{account.type}）{account.is_active ? '' : ' · 已停用'}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={() => void handleSaveRouting()} disabled={saving || routingLoading} className="rounded-xl bg-primary-600 text-white text-sm font-semibold px-4 py-2 hover:bg-primary-500 disabled:opacity-60">
              保存路由
            </button>
            <button type="button" onClick={() => setRoutingProfile(null)} className="rounded-xl border border-white/20 px-4 py-2 text-sm">关闭</button>
          </div>
        </div>
      )}
    </section>
  );
}
