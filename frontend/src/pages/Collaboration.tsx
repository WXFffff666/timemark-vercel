import { useCallback, useEffect, useState } from 'react';
import { Users, Loader2, Plus, Trash2, Copy, CheckCircle2, Link2, ShieldCheck, Activity } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { formatShortTime as fmtTime } from '@/lib/format';

/**
 * v2.38 R14（审计 D3 #1）：家庭协作管理页——collaboration 路由（11 端点）此前零 UI，
 * 三本迭代账本连续列为素材。owner 侧：邀请创建（viewer/commenter/editor 三档 +
 * scope 限定）+ 一次性 token 显示 + 撤销 + 活动流。guest 侧视图由 token 直达
 * （/shared 同款免登录模式，不在此页）。
 */

type Role = 'viewer' | 'commenter' | 'editor';

interface Invite {
  id: number;
  email: string | null;
  label: string | null;
  role: Role;
  scope: { profileId?: number | null; tag?: string | null; entityTypes?: string[] };
  expiresAt: string | null;
  revokedAt: string | null;
  acceptedAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string | null;
}

interface ActivityItem {
  id: number;
  actorKind: 'owner' | 'guest';
  actorLabel: string | null;
  inviteId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: unknown;
  createdAt?: string;
}

const ROLE_LABELS: Record<Role, string> = {
  viewer: '只读',
  commenter: '可评论',
  editor: '可编辑',
};

const ACTION_LABELS: Record<string, string> = {
  guest_viewed: '查看了共享',
  guest_commented: '发表了评论',
  guest_created_event: '创建了事件',
  invite_created: '邀请已创建',
  invite_revoked: '邀请已撤销',
};

export default function Collaboration() {
  // v2.40 R18：统一确认弹窗（Promise 化 confirm，遮蔽全局同名函数）
  const { confirm, confirmDialog } = useConfirm();
  const [invites, setInvites] = useState<Invite[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 创建表单
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('viewer');
  const [tag, setTag] = useState('');
  const [expiryDays, setExpiryDays] = useState('30');

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<Invite[]>('/collaboration/invites').catch(() => []),
      api.get<ActivityItem[]>('/collaboration/activity').catch(() => []),
    ])
      .then(([inv, act]) => {
        setInvites(Array.isArray(inv) ? inv : []);
        setActivity(Array.isArray(act) ? act : []);
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (!label.trim()) {
      setError('请填写邀请备注（如：给妈妈看）');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await api.post<{ token: string }>('/collaboration/invites', {
        label: label.trim(),
        email: email.trim() || null,
        role,
        scope: tag.trim() ? { tag: tag.trim() } : {},
        expiresInDays: Number(expiryDays) || undefined,
      });
      setFreshToken(res.token);
      setLabel('');
      setEmail('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (id: number) => {
    if (!(await confirm({ title: '撤销该邀请链接？', description: '撤销后立即失效。', tone: 'danger', confirmLabel: '撤销' }))) return;
    setError('');
    try {
      await api.delete(`/collaboration/invites/${id}`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '撤销失败');
    }
  };

  const guestUrl = (token: string): string => `${window.location.origin}/collaboration/${token}`;

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="家庭协作"
        subtitle="生成只读/可评论/可编辑链接，让家人查看或参与你的日程"
        back="smart"
        onRefresh={load}
        refreshing={loading}
      />

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {error && (
          <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}

        {/* 创建表单 */}
        <div className="glass-panel rounded-3xl p-5 space-y-3">
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <Plus size={14} aria-hidden /> 创建协作邀请
          </h2>
          <div className="flex flex-wrap gap-2 items-end">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="备注（必填，如 给妈妈看）" aria-label="邀请备注" className="flex-1 min-w-[10rem]" />
            <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="对方邮箱（可选）" aria-label="对方邮箱" type="email" className="w-44" />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="权限" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
              {(Object.entries(ROLE_LABELS) as Array<[Role, string]>).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
            <Input value={tag} onChange={(e) => setTag(e.target.value)} placeholder="限定标签（可选）" aria-label="限定标签" className="w-36" />
            <select value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} aria-label="有效期" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
              <option value="7">7 天有效</option>
              <option value="30">30 天有效</option>
              <option value="90">90 天有效</option>
              <option value="365">365 天有效</option>
            </select>
            <Button onClick={() => void create()} disabled={creating} aria-label="创建邀请">
              {creating ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : <Plus className="w-4 h-4 mr-1" aria-hidden />}
              创建
            </Button>
          </div>
          <p className="text-xs text-slate-400">
            只读 = 仅查看；可评论 = 查看+留言；可编辑 = 还能创建事件。可以限定对方只看到某个标签/档案的内容。
          </p>
        </div>

        {/* 一次性 token */}
        {freshToken && (
          <div className="rounded-3xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-900/20 p-5 space-y-2">
            <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
              <ShieldCheck size={16} aria-hidden /> 链接只显示这一次，请立即复制发给对方
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs break-all font-mono text-slate-800 dark:text-slate-100">{guestUrl(freshToken)}</code>
              <Button
                size="sm"
                variant="outline"
                aria-label="复制邀请链接"
                onClick={() => {
                  navigator.clipboard.writeText(guestUrl(freshToken)).catch(() => undefined);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
              >
                {copied ? <CheckCircle2 size={14} className="text-emerald-600" aria-hidden /> : <Copy size={14} aria-hidden />}
              </Button>
            </div>
          </div>
        )}

        {/* 邀请列表 */}
        <section aria-labelledby="invites-heading">
          <h2 id="invites-heading" className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2 px-1 flex items-center gap-1.5">
            <Link2 size={14} aria-hidden /> 邀请列表（{invites.length}）
          </h2>
          {loading ? (
            <SkeletonCard count={3} />
          ) : invites.length === 0 ? (
            <EmptyState icon={Users} title="还没有协作邀请" description="创建一个链接，家人无需注册即可查看你的日程" />
          ) : (
            <ul className="space-y-2">
              {invites.map((inv) => {
                const revoked = inv.revokedAt !== null;
                return (
                  <li key={inv.id} className={`glass-panel rounded-2xl px-4 py-3 ${revoked ? 'opacity-50' : ''}`}>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{inv.label || inv.email || `邀请 #${inv.id}`}</span>
                          <Badge variant="outline" className="scale-90">{ROLE_LABELS[inv.role]}</Badge>
                          {inv.scope?.tag && <Badge variant="secondary" className="scale-90">限定 {inv.scope.tag}</Badge>}
                          {revoked ? (
                            <Badge variant="destructive" className="scale-90">已撤销</Badge>
                          ) : inv.expiresAt && new Date(inv.expiresAt) < new Date() ? (
                            <Badge variant="destructive" className="scale-90">已过期</Badge>
                          ) : (
                            <Badge variant="default" className="scale-90">有效</Badge>
                          )}
                        </div>
                        <p className="text-xs text-slate-400 mt-1">
                          访问 {inv.accessCount} 次 · 最近 {fmtTime(inv.lastAccessedAt)} · 创建 {fmtTime(inv.createdAt)} · 过期 {fmtTime(inv.expiresAt)}
                        </p>
                      </div>
                      {!revoked && (
                        <Button size="icon" variant="ghost" className="min-h-9 min-w-9 text-red-500 shrink-0" aria-label={`撤销「${inv.label || inv.email || inv.id}」`} onClick={() => void revoke(inv.id)}>
                          <Trash2 size={15} aria-hidden />
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* 活动流 */}
        <section aria-labelledby="activity-heading">
          <h2 id="activity-heading" className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2 px-1 flex items-center gap-1.5">
            <Activity size={14} aria-hidden /> 协作活动流
          </h2>
          {activity.length === 0 ? (
            <EmptyState icon={Users} title="暂无协作活动" description="对方查看/评论/创建时这里会出现流水" />
          ) : (
            <ul className="glass-panel rounded-3xl p-4 space-y-1.5 ring-1 ring-black/5 dark:ring-white/10">
              {activity.slice(0, 15).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${a.actorKind === 'guest' ? 'bg-blue-500' : 'bg-slate-400'}`} aria-hidden />
                  <span className="text-slate-700 dark:text-slate-200 shrink-0">{a.actorLabel || (a.actorKind === 'owner' ? '我' : '访客')}</span>
                  <span className="truncate">{ACTION_LABELS[a.action] ?? a.action}</span>
                  <span className="text-slate-400 ml-auto shrink-0">{fmtTime(a.createdAt ?? null)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      {confirmDialog}
    </div>
  );
}
