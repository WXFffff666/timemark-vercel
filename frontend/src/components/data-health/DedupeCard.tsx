import { useCallback, useEffect, useState } from 'react';
import { CopyPlus, Loader2, Users, CalendarDays, CheckCircle2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * v2.31 R5（审计 D4）：重复数据清理卡——/api/dedupe（task 135）此前零 UI，
 * 联系人/事件重复候选只能靠 API 裸调。合并走既有 task-126 决定卡流
 * （AgentConsole 里 Approve/Edit/Reject），本卡只负责"发现 + 提议"，绝不自动删改。
 */

interface DedupeEntity {
  id: number;
  label: string;
  detail?: string;
}

interface DedupeCandidate {
  kind: 'event' | 'contact';
  score: number;
  reasons: string[];
  summary: string;
  entities: [DedupeEntity, DedupeEntity];
  suggestedAction: { type: 'review'; hint: string } | { type: 'propose_merge'; hint?: string; subjectKind?: string };
}

interface DedupeResponse {
  events: DedupeCandidate[];
  contacts: DedupeCandidate[];
  note?: string;
}

function scoreStyle(score: number): string {
  if (score >= 0.85) return 'bg-red-50 text-red-600 dark:bg-red-900/30 dark:text-red-300';
  if (score >= 0.6) return 'bg-amber-50 text-amber-600 dark:bg-amber-900/30 dark:text-amber-300';
  return 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400';
}

function CandidateRow({
  candidate,
  action,
}: {
  candidate: DedupeCandidate;
  action?: React.ReactNode;
}) {
  const [a, b] = candidate.entities;
  return (
    <li className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap text-sm">
            <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{a.label}</span>
            <span className="text-slate-400" aria-hidden>⇄</span>
            <span className="font-semibold text-slate-800 dark:text-slate-100 truncate">{b.label}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${scoreStyle(candidate.score)}`}>
              相似度 {Math.round(candidate.score * 100)}%
            </span>
          </div>
          {candidate.reasons.length > 0 && (
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">理由：{candidate.reasons.join('；')}</p>
          )}
          {candidate.suggestedAction.type === 'review' && (
            <p className="text-xs text-slate-400 mt-1">{candidate.suggestedAction.hint}</p>
          )}
        </div>
        {action}
      </div>
    </li>
  );
}

export function DedupeCard() {
  const [data, setData] = useState<DedupeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [proposing, setProposing] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<DedupeResponse>('/dedupe?limit=20')
      .then((d) => setData({ events: d.events ?? [], contacts: d.contacts ?? [], note: d.note }))
      .catch(() => setData({ events: [], contacts: [] }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const proposeMerge = async (candidate: DedupeCandidate) => {
    const [a, b] = candidate.entities;
    if (!confirm(`提议合并「${a.label}」与「${b.label}」？\n合并将生成一张决定卡（在「智能体控制台」审批），不会立即改动数据。`)) return;
    const key = `${a.id}-${b.id}`;
    setProposing(key);
    setNotice(null);
    try {
      const res = await api.post<{ status: string; created: boolean; message: string; cardId: number | null }>(
        '/dedupe/contacts/propose-merge',
        { keepContactId: a.id, mergeContactId: b.id },
      );
      const where = res.cardId ? '（到「智能体控制台 → 决定卡」审批）' : '';
      setNotice({ ok: true, text: `${res.message}${where}` });
      if (res.created) load();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '提议失败' });
    } finally {
      setProposing(null);
    }
  };

  const empty = !data || (data.events.length === 0 && data.contacts.length === 0);

  return (
    <section aria-labelledby="dedupe-heading" className="mb-8">
      <div className="glass-panel rounded-3xl p-6 ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h2 id="dedupe-heading" className="text-lg font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            <CopyPlus className="w-5 h-5 text-violet-500" aria-hidden /> 重复数据清理
          </h2>
          <Button size="sm" variant="outline" className="rounded-full" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
            重新扫描
          </Button>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          扫描重复的联系人 / 事件候选（只读）。联系人合并需要你在「智能体控制台」的决定卡里审批，系统绝不自动删除数据。
        </p>

        {notice && (
          <p
            role="status"
            className={`mb-4 flex items-center gap-2 rounded-2xl px-4 py-3 text-sm ${
              notice.ok
                ? 'border border-emerald-200/60 bg-emerald-50/60 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/10 dark:text-emerald-300'
                : 'border border-red-200/60 bg-red-50/60 text-red-600 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300'
            }`}
          >
            <CheckCircle2 size={16} aria-hidden /> {notice.text}
          </p>
        )}

        {loading && !data ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" aria-hidden />
          </div>
        ) : empty ? (
          <EmptyState
            icon={CopyPlus}
            title="没有发现重复数据"
            description="联系人与事件唯一性检查通过；新增数据后会随扫描更新"
          />
        ) : (
          <div className="space-y-5">
            {data!.contacts.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                  <Users size={14} aria-hidden /> 重复联系人候选（{data!.contacts.length}）
                </h3>
                <ul className="space-y-2">
                  {data!.contacts.map((c) => (
                    <CandidateRow
                      key={`c-${c.entities[0].id}-${c.entities[1].id}`}
                      candidate={c}
                      action={
                        c.suggestedAction.type === 'propose_merge' ? (
                          <Button
                            size="sm"
                            variant="outline"
                            className="rounded-full shrink-0"
                            disabled={proposing !== null}
                            onClick={() => void proposeMerge(c)}
                          >
                            {proposing === `${c.entities[0].id}-${c.entities[1].id}` ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden />
                            ) : null}
                            提议合并
                          </Button>
                        ) : undefined
                      }
                    />
                  ))}
                </ul>
              </div>
            )}
            {data!.events.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                  <CalendarDays size={14} aria-hidden /> 疑似重复事件（{data!.events.length}）
                </h3>
                <ul className="space-y-2">
                  {data!.events.map((c) => (
                    <CandidateRow key={`e-${c.entities[0].id}-${c.entities[1].id}`} candidate={c} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
