import { useCallback, useEffect, useState } from 'react';
import { GitPullRequest, Loader2, Check, X, Pencil, Inbox as InboxIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { formatShortTime as fmtTime } from '@/lib/format';
import { Button } from '@/components/ui/button';

/**
 * v2.38 R15b（方面 5）：决定卡审批面板——/decisions 路由（8 端点）此前只有
 * /dedupe/propose-merge 一个入口写入，审批闭环断在半路。挂在 DataHealth 页
 * （与去重卡同域：AI 提议 → 人工批准/编辑/拒绝）。
 */

type DecisionStatus = 'pending' | 'approved' | 'rejected' | 'target_missing' | 'expired';

interface DecisionCard {
  id: number;
  subject_kind: string;
  subject_ref: string | null;
  action: string;
  summary: string;
  payload: Record<string, unknown>;
  status: DecisionStatus;
  is_question: boolean;
  rationale: string | null;
  created_at: string;
}

interface FeedProposal {
  id: number;
  source_kind: string;
  kind: string;
  title: string;
  payload: Record<string, unknown>;
  status: string;
  created_at: string;
}

const SUBJECT_LABELS: Record<string, string> = {
  reschedule_reminder: '改期提醒',
  merge_contacts: '合并联系人',
  archive_completed: '归档完成项',
  adjust_cadence: '调整联系节奏',
  accept_tag: '采纳标签',
};

export function DecisionsPanel() {
  const [cards, setCards] = useState<DecisionCard[]>([]);
  const [proposals, setProposals] = useState<FeedProposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      api.get<DecisionCard[]>('/decisions?status=pending&limit=20').catch(() => []),
      api.get<FeedProposal[]>('/feeds/proposals?limit=10').catch(() => []),
    ])
      .then(([d, p]) => {
        setCards(Array.isArray(d) ? d : []);
        setProposals(Array.isArray(p) ? p : []);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const act = async (kind: 'approve' | 'reject', card: DecisionCard) => {
    setBusyId(`d-${card.id}-${kind}`);
    setNotice(null);
    try {
      await api.post(`/decisions/${card.id}/${kind}`, {});
      setNotice({ ok: true, text: `${SUBJECT_LABELS[card.subject_kind] ?? card.subject_kind} 已${kind === 'approve' ? '批准' : '拒绝'}` });
      load();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '操作失败' });
    } finally {
      setBusyId(null);
    }
  };

  const editCard = async (card: DecisionCard) => {
    // merge_contacts：允许编辑保留方
    const keep = prompt(`编辑合并保留方（当前：${String(card.payload?.keepContactId ?? '?')}），输入要保留的联系人 ID：`, String(card.payload?.keepContactId ?? ''));
    if (keep === null) return;
    const keepId = Number(keep);
    if (!Number.isInteger(keepId) || keepId <= 0) {
      setNotice({ ok: false, text: 'ID 必须是正整数' });
      return;
    }
    setBusyId(`d-${card.id}-edit`);
    try {
      await api.post(`/decisions/${card.id}/edit`, { payload: { ...card.payload, keepContactId: keepId } });
      setNotice({ ok: true, text: '已按编辑后的方案批准' });
      load();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '编辑失败' });
    } finally {
      setBusyId(null);
    }
  };

  const reviewProposal = async (id: number, accept: boolean) => {
    setBusyId(`p-${id}-${accept ? 'a' : 'r'}`);
    setNotice(null);
    try {
      await api.post(`/feeds/proposals/${id}/${accept ? 'accept' : 'reject'}`, {});
      setNotice({ ok: true, text: accept ? '提案已采纳入库' : '提案已拒绝' });
      load();
    } catch (e) {
      setNotice({ ok: false, text: e instanceof Error ? e.message : '操作失败' });
    } finally {
      setBusyId(null);
    }
  };

  const pendingCards = cards.filter((c) => c.status === 'pending');
  const pendingProposals = proposals.filter((p) => p.status === 'pending');

  return (
    <section aria-labelledby="decisions-heading" className="mb-8">
      <div className="glass-panel rounded-3xl p-6 ring-1 ring-black/5 dark:ring-white/10">
        <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
          <h2 id="decisions-heading" className="text-lg font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            <GitPullRequest className="w-5 h-5 text-cyan-500" aria-hidden /> 待审批提议
            {(pendingCards.length > 0 || pendingProposals.length > 0) && (
              <Badge variant="default" className="scale-90">{pendingCards.length + pendingProposals.length}</Badge>
            )}
          </h2>
          <Button size="sm" variant="outline" className="rounded-full" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
            刷新
          </Button>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400 mb-4">
          AI 与外部数据源提出的操作建议需要你批准后才会执行；拒绝会被系统记住（同类提议不再重复打扰）。
        </p>

        {notice && (
          <p role="status" className={`mb-4 rounded-xl px-4 py-2 text-sm ${notice.ok ? 'border border-emerald-200/60 bg-emerald-50/60 text-emerald-700 dark:border-emerald-800/40 dark:bg-emerald-900/10 dark:text-emerald-300' : 'border border-red-200/60 bg-red-50/60 text-red-600 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300'}`}>
            {notice.text}
          </p>
        )}

        {loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-slate-400" aria-hidden />
          </div>
        ) : pendingCards.length === 0 && pendingProposals.length === 0 ? (
          <EmptyState icon={Check} title="没有待审批的提议" description="AI 去重合并与外部订阅提案会出现在这里" />
        ) : (
          <div className="space-y-5">
            {pendingCards.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2">决定卡（{pendingCards.length}）</h3>
                <ul className="space-y-2">
                  {pendingCards.map((card) => (
                    <li key={card.id} className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3">
                      <div className="flex items-start justify-between gap-3 flex-wrap">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className="scale-90 shrink-0">{SUBJECT_LABELS[card.subject_kind] ?? card.subject_kind}</Badge>
                            {card.is_question && <Badge variant="secondary" className="scale-90">提问</Badge>}
                            <span className="text-xs text-slate-400">{fmtTime(card.created_at)}</span>
                          </div>
                          <p className="text-sm text-slate-800 dark:text-slate-100 mt-1">{card.summary}</p>
                          {card.rationale && <p className="text-xs text-slate-400 mt-1">理由：{card.rationale}</p>}
                        </div>
                        <div className="flex gap-1.5 shrink-0">
                          {card.subject_kind === 'merge_contacts' && (
                            <Button size="sm" variant="outline" className="rounded-full h-8" disabled={busyId !== null} onClick={() => void editCard(card)}>
                              <Pencil size={13} className="mr-1" aria-hidden /> 编辑
                            </Button>
                          )}
                          <Button size="sm" variant="default" className="rounded-full h-8" disabled={busyId !== null} onClick={() => void act('approve', card)}>
                            {busyId === `d-${card.id}-approve` ? <Loader2 size={13} className="animate-spin" aria-hidden /> : <Check size={13} className="mr-1" aria-hidden />}
                            批准
                          </Button>
                          <Button size="sm" variant="ghost" className="rounded-full h-8 text-red-500" disabled={busyId !== null} onClick={() => void act('reject', card)}>
                            <X size={13} className="mr-1" aria-hidden /> 拒绝
                          </Button>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {pendingProposals.length > 0 && (
              <div>
                <h3 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-2 flex items-center gap-1.5">
                  <InboxIcon size={13} aria-hidden /> 订阅源提案（{pendingProposals.length}）
                </h3>
                <ul className="space-y-2">
                  {pendingProposals.map((p) => (
                    <li key={p.id} className="rounded-2xl border border-slate-200/70 dark:border-slate-700/50 px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge variant="outline" className="scale-90 shrink-0">{p.kind}</Badge>
                          <span className="text-xs text-slate-400">{fmtTime(p.created_at)}</span>
                        </div>
                        <p className="text-sm text-slate-800 dark:text-slate-100 mt-1 truncate">{p.title}</p>
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        <Button size="sm" variant="default" className="rounded-full h-8" disabled={busyId !== null} onClick={() => void reviewProposal(p.id, true)}>
                          采纳
                        </Button>
                        <Button size="sm" variant="ghost" className="rounded-full h-8 text-red-500" disabled={busyId !== null} onClick={() => void reviewProposal(p.id, false)}>
                          拒绝
                        </Button>
                      </div>
                    </li>
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
