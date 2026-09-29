import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Copy, Check, Pencil, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import {
  createAgentToken,
  fetchAgentTokens,
  renameAgentToken,
  revokeAgentToken,
  type AgentTokenScope,
  type AgentTokenView,
} from '@/lib/api';

/**
 * checkbox 101: create / rename / revoke scoped agent tokens.
 *
 * A raw token is shown ONCE at creation, then never again - the server keeps only its
 * SHA-256 hash. The default scope is `read`; a token can only widen to `write`/`admin`
 * when the user explicitly picks it. Visual language mirrors the neighbouring Settings
 * sections (glass-panel, rounded-[2.5rem], ui Input/Select/Button).
 */

const SCOPE_OPTIONS: ReadonlyArray<{ value: AgentTokenScope; label: string }> = [
  { value: 'read', label: '只读（read）' },
  { value: 'write', label: '读写（write）' },
  { value: 'admin', label: '全部（admin）' },
];

const SCOPE_SHORT: Record<AgentTokenScope, string> = {
  read: 'read',
  write: 'write',
  admin: 'admin',
};

function isTokenPayload(value: unknown): value is { tokens: AgentTokenView[] } {
  return !!value && typeof value === 'object' && Array.isArray((value as { tokens?: unknown }).tokens);
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : '—';
}

export function AgentTokensSettings() {
  const [tokens, setTokens] = useState<AgentTokenView[]>([]);
  const [loading, setLoading] = useState(true);
  const [name, setName] = useState('');
  const [scope, setScope] = useState<AgentTokenScope>('read');
  const [creating, setCreating] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await fetchAgentTokens();
      if (isTokenPayload(data)) setTokens(data.tokens);
    } catch {
      // Degrade quietly: an unreachable endpoint never blocks the Settings page.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createAgentToken(trimmed, [scope]);
      setNewToken(created.token);
      setCopied(false);
      setName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  async function handleCopy() {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  async function handleRevoke(id: string) {
    setBusyId(id);
    setError(null);
    try {
      await revokeAgentToken(id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '撤销失败');
    } finally {
      setBusyId(null);
    }
  }

  async function handleRename(id: string) {
    const trimmed = editName.trim();
    if (!trimmed) return;
    setBusyId(id);
    setError(null);
    try {
      await renameAgentToken(id, trimmed);
      setEditingId(null);
      setEditName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
        <KeyRound className="w-4 h-4" /> 智能体令牌（Agent Tokens）
      </h2>
      <div className="glass-panel rounded-[2.5rem] p-6 space-y-4 ring-1 ring-black/5 dark:ring-white/10">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          为 MCP / 工具调用创建受限令牌。令牌明文只在创建时显示一次，服务端仅保存其 SHA-256 哈希；
          默认权限为<b>只读（read）</b>，撤销后立即失效。
        </p>

        <div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]">
          <Input
            placeholder="令牌名称（如 我的 MCP 客户端）"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="令牌名称"
          />
          <Select
            value={scope}
            onChange={(e) => setScope(e.target.value as AgentTokenScope)}
            aria-label="令牌权限"
          >
            {SCOPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button onClick={handleCreate} disabled={creating || !name.trim()} data-testid="agent-token-create">
            {creating ? '创建中...' : '创建令牌'}
          </Button>
        </div>

        {newToken && (
          <div
            className="rounded-2xl border border-amber-300/70 dark:border-amber-700/60 bg-amber-50/80 dark:bg-amber-900/20 p-4 space-y-2"
            role="status"
            data-testid="agent-token-new"
          >
            <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
              请复制它；此后不再显示。
            </p>
            <pre className="text-xs font-mono break-all whitespace-pre-wrap rounded-xl bg-white/70 dark:bg-black/30 p-3">
              {newToken}
            </pre>
            <div className="flex gap-2">
              <Button onClick={handleCopy} className="gap-2" data-testid="agent-token-copy">
                {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                {copied ? '已复制' : '复制'}
              </Button>
              <Button
                onClick={() => {
                  setNewToken(null);
                  setCopied(false);
                }}
                className="gap-2"
                data-testid="agent-token-dismiss"
              >
                <X className="w-4 h-4" /> 我已保存，隐藏
              </Button>
            </div>
          </div>
        )}

        {error && (
          <p className="text-sm text-red-500" role="status">
            {error}
          </p>
        )}

        <div className="space-y-2">
          {loading ? (
            <p className="text-xs text-slate-500 dark:text-slate-400" role="status">
              正在加载令牌…
            </p>
          ) : tokens.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400" role="status">
              还没有令牌。
            </p>
          ) : (
            tokens.map((token) => {
              const revoked = token.revokedAt !== null;
              return (
                <div
                  key={token.id}
                  className="flex flex-wrap items-center gap-2 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-black/20 p-3"
                >
                  <div className="flex-1 min-w-[12rem]">
                    {editingId === token.id ? (
                      <Input
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        aria-label="重命名令牌"
                        autoFocus
                      />
                    ) : (
                      <>
                        <p className="text-sm font-semibold text-slate-900 dark:text-white">{token.name}</p>
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          {token.scopes.map((s) => SCOPE_SHORT[s] ?? s).join(' · ')} · 创建于 {formatTime(token.createdAt)} ·
                          最近使用 {formatTime(token.lastUsedAt)}
                        </p>
                      </>
                    )}
                  </div>

                  {revoked ? (
                    <span className="text-xs font-semibold text-red-500 px-2">已撤销</span>
                  ) : editingId === token.id ? (
                    <div className="flex gap-2">
                      <Button onClick={() => handleRename(token.id)} disabled={busyId === token.id} className="gap-1">
                        <Check className="w-4 h-4" /> 保存
                      </Button>
                      <Button
                        onClick={() => {
                          setEditingId(null);
                          setEditName('');
                        }}
                        className="gap-1"
                      >
                        <X className="w-4 h-4" /> 取消
                      </Button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <Button
                        onClick={() => {
                          setEditingId(token.id);
                          setEditName(token.name);
                        }}
                        className="gap-1"
                        aria-label={`重命名 ${token.name}`}
                      >
                        <Pencil className="w-4 h-4" /> 重命名
                      </Button>
                      <Button
                        onClick={() => handleRevoke(token.id)}
                        disabled={busyId === token.id}
                        className="gap-1"
                        aria-label={`撤销 ${token.name}`}
                      >
                        <Trash2 className="w-4 h-4" /> 撤销
                      </Button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
