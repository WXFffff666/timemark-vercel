import { useEffect, useState } from 'react';
import { Code2, Copy, Plus, Trash2, RefreshCw, CheckCircle2, XCircle, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * v2.30 方向 B：API 门户 —— 对外 REST API 的 Token 管理与文档页。
 *
 * Token 全套能力复用既有 /api/agent-tokens 端点（与 MCP 同一套 tmt_ 令牌、
 * 同一套 scopes），原始 token 只在创建响应里出现一次。REST 端点族（/api/v1/*）
 * 与 MCP 共用鉴权/限流/审计基建，文档区手写轻量渲染（不引入 swagger-ui）。
 */

interface TokenView {
  id: string;
  name: string;
  scopes: string[];
  createdAt?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastUsedAt?: string | null;
  masked?: string;
}

interface AuditRow {
  id: string;
  tool?: string;
  created_at?: string;
  decision?: string;
}

const ENDPOINTS = [
  { method: 'GET', path: '/api/v1/events', scope: 'read', desc: '事件列表（?from=&to=&limit=，limit 上限 100）' },
  { method: 'GET', path: '/api/v1/events/:id', scope: 'read', desc: '单个事件详情' },
  { method: 'GET', path: '/api/v1/expiry', scope: 'read', desc: '到期中心条目（?within=天 数、?kind=）' },
  { method: 'GET', path: '/api/v1/habits', scope: 'read', desc: '习惯与连击' },
  { method: 'GET', path: '/api/v1/stats/daily', scope: 'read', desc: '每日统计（?from=&to=）' },
  { method: 'POST', path: '/api/v1/events', scope: 'write', desc: '新建事件（请求体与页面创建事件一致）' },
];

const SCOPES = ['read', 'write', 'admin'] as const;

export default function ApiPortal() {
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newScopes, setNewScopes] = useState<string[]>(['read']);
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setLoading(true);
    setError('');
    api
      .get<{ tokens: TokenView[] }>('/agent-tokens')
      .then(async (d) => {
        const list = d.tokens ?? [];
        setTokens(list);
        // 拉第一个活跃 token 的最近调用（门户页只展示一条流水足够）
        const first = list.find((t) => !t.revokedAt);
        if (first) {
          const rows = await api
            .get<AuditRow[]>(`/agent-tokens/${first.id}/audit?limit=10`)
            .catch(() => []);
          setAudit(Array.isArray(rows) ? rows : []);
        } else {
          setAudit([]);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    load();
  }, []);

  const createToken = async () => {
    if (!newName.trim()) {
      setError('请填写 Token 名称');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await api.post<{ token: string; record: TokenView }>('/agent-tokens', {
        name: newName.trim(),
        scopes: newScopes,
      });
      setFreshToken(res.token);
      setNewName('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const revokeToken = async (id: string) => {
    if (!confirm('确定回收该 Token？使用它的集成将立即失效，且不可恢复。')) return;
    try {
      await api.post(`/agent-tokens/${id}/revoke`, {});
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '回收失败');
    }
  };

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).catch(() => undefined);
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="API 门户"
        subtitle="对外 REST API · Token 管理与接入文档"
        onRefresh={load}
        refreshing={loading}
      />

      <main className="max-w-4xl mx-auto px-6 space-y-8">
        {error && (
          <div className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </div>
        )}

        {/* Token 管理 */}
        <section>
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wider flex items-center gap-2">
            <ShieldCheck className="w-4 h-4" /> API Token
          </h2>
          <div className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 space-y-4">
            <div className="flex flex-wrap gap-2 items-end">
              <div className="flex-1 min-w-[10rem]">
                <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 block">新 Token 名称</label>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="如：家庭服务器 / 自动化脚本"
                  aria-label="新 Token 名称"
                />
              </div>
              <div className="flex gap-1" role="group" aria-label="权限范围">
                {SCOPES.map((s) => (
                  <Button
                    key={s}
                    size="sm"
                    variant={newScopes.includes(s) ? 'default' : 'outline'}
                    className="rounded-full"
                    onClick={() =>
                      setNewScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]))
                    }
                  >
                    {s}
                  </Button>
                ))}
              </div>
              <Button onClick={createToken} disabled={creating} aria-label="创建 Token">
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
                创建
              </Button>
            </div>
            <p className="text-xs text-slate-400">
              默认只给 read；write 才能调写端点；admin 仅内部使用。Token 只在创建成功时完整显示一次，请立即保存。
            </p>

            {freshToken && (
              <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50/70 dark:bg-emerald-900/20 p-4">
                <p className="text-sm font-semibold text-emerald-700 dark:text-emerald-300 mb-1">请立即复制（只显示这一次）：</p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 text-xs break-all font-mono text-slate-800 dark:text-slate-100">{freshToken}</code>
                  <Button size="sm" variant="outline" onClick={() => copy(freshToken, 'Token')} aria-label="复制 Token">
                    <Copy size={14} />
                  </Button>
                </div>
              </div>
            )}

            {loading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
            ) : tokens.length === 0 ? (
              <EmptyState icon={Code2} title="还没有 API Token" description="创建一个 Token 后即可通过 REST API 读取你的数据" />
            ) : (
              <ul className="space-y-2">
                {tokens.map((t) => (
                  <li key={t.id} className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3 flex flex-wrap items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{t.name}</p>
                      <p className="text-xs text-slate-400 font-mono">{t.masked ?? `…${t.id.slice(-4)}`}</p>
                    </div>
                    <div className="flex gap-1">
                      {t.scopes.map((s) => (
                        <Badge key={s} variant="outline" className="scale-90">{s}</Badge>
                      ))}
                    </div>
                    {t.revokedAt ? (
                      <Badge variant="destructive" className="scale-90">已回收</Badge>
                    ) : (
                      <Button size="sm" variant="ghost" className="text-red-500 rounded-full" onClick={() => revokeToken(t.id)} aria-label={`回收 ${t.name}`}>
                        <Trash2 size={14} />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 端点文档 */}
        <section>
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wider flex items-center gap-2">
            <Code2 className="w-4 h-4" /> REST 端点（/api/v1）
          </h2>
          <div className="glass-panel rounded-[2rem] p-6 ring-1 ring-black/5 dark:ring-white/10 space-y-3">
            <p className="text-sm text-slate-500 dark:text-slate-400">
              所有请求携带 <code className="font-mono">Authorization: Bearer tmt_…</code>；响应统一 <code className="font-mono">{'{ success, data | error }'}</code>；
              每个 Token 每分钟 120 次（超限返回 429 与 Retry-After）；每次调用都会写入审计日志。
            </p>
            <ul className="space-y-2">
              {ENDPOINTS.map((ep) => (
                <li key={`${ep.method} ${ep.path}`} className="rounded-xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={ep.method === 'GET' ? 'secondary' : 'default'} className="font-mono">{ep.method}</Badge>
                    <code className="text-sm font-mono text-slate-800 dark:text-slate-100">{ep.path}</code>
                    <Badge variant="outline" className="scale-90">{ep.scope}</Badge>
                  </div>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{ep.desc}</p>
                </li>
              ))}
            </ul>
            <div className="rounded-xl bg-slate-50 dark:bg-slate-800/60 p-4">
              <p className="text-xs font-semibold text-slate-500 mb-2">curl 示例</p>
              <div className="flex items-start gap-2">
                <pre className="flex-1 text-xs overflow-x-auto text-slate-700 dark:text-slate-200 font-mono">{`curl -H "Authorization: Bearer tmt_xxx" \\
  https://你的域名/api/v1/events?limit=10`}</pre>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="复制 curl 示例"
                  onClick={() => copy('curl -H "Authorization: Bearer tmt_xxx" https://你的域名/api/v1/events?limit=10', 'curl 示例')}
                >
                  <Copy size={14} />
                </Button>
              </div>
            </div>
          </div>
        </section>

        {/* 最近调用 */}
        <section>
          <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 uppercase tracking-wider flex items-center gap-2">
            <RefreshCw className="w-4 h-4" /> 最近调用（审计）
          </h2>
          {audit.length === 0 ? (
            <EmptyState icon={Code2} title="暂无调用记录" description="使用 Token 调用 API 后会在这里看到审计流水" />
          ) : (
            <ul className="glass-panel rounded-[2rem] p-4 space-y-1.5 ring-1 ring-black/5 dark:ring-white/10">
              {audit.slice(0, 10).map((a) => (
                <li key={a.id} className="flex items-center gap-2 text-xs">
                  {a.decision === 'allowed' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                  ) : (
                    <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                  )}
                  <span className="font-mono text-slate-700 dark:text-slate-200 truncate">{a.tool ?? '—'}</span>
                  <span className="text-slate-400 ml-auto shrink-0">{a.created_at ? new Date(a.created_at).toLocaleString('zh-CN') : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
