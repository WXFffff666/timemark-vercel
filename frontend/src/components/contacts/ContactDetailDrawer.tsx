import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Clock, Gift, Loader2, MessageSquare, Phone, Users, Utensils } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContactTimeline } from '@/components/contacts/ContactTimeline';
import { api } from '@/lib/api';
import {
  CADENCE_DAY_PRESETS,
  getRelationshipCategory,
  resolveContactGreetingName,
  resolveRelationshipOption,
  type GiftDirection,
  type InteractionKind,
  type TimelineEntry,
} from '@timemark/shared';
import {
  INTERACTION_QUICK_ACTIONS,
  computeNextDueAt,
  formatCadenceLabel,
  formatYmdLocal,
  interactionKindLabel,
  isCadenceDue,
  latestInteractionAt,
  relationshipCategoryLabel,
} from '@/lib/contact-crm-utils';

/** 抽屉只依赖这几个字段（Contacts.tsx 的 FixedContact 结构上兼容）。 */
export interface ContactSummary {
  id: number;
  name: string;
  nickname?: string | null;
  relationship?: string | null;
  gender?: string | null;
  cadence_days?: number | null;
  cadence_enabled?: boolean;
  last_contact_at?: string | null;
}

interface ContactDetailDrawerProps {
  contact: ContactSummary | null;
  open: boolean;
  /** 服务端 `GET /api/contacts/due` 是否包含该联系人（权威到期判定）。 */
  due: boolean;
  onOpenChange: (open: boolean) => void;
  /** 记录互动 / 保存节奏后通知父级重新拉取联系人与到期列表。 */
  onChanged: () => void;
}

const QUICK_ICON: Record<InteractionKind, typeof Phone> = {
  call: Phone,
  message: MessageSquare,
  meeting: Users,
  meal: Utensils,
  visit: Users,
  gift: Gift,
  other: Clock,
};

const PAGE_LIMIT = 20;

/**
 * 联系人详情抽屉（plan todo 63）：关系标签 + 垂直时间线 + 「记录联系」快捷动作 +
 * 联系节奏 + 到期徽章。
 *
 * 约定（promise）只读：后端当前只暴露 POST /promises，没有完成接口，
 * 因此时间线里不渲染任何完成操作（见 evidence 的 follow-up 说明）。
 */
export function ContactDetailDrawer({
  contact,
  open,
  due,
  onOpenChange,
  onChanged,
}: ContactDetailDrawerProps) {
  const contactId = contact?.id ?? null;

  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [timelinePage, setTimelinePage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [timelineError, setTimelineError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  const [summary, setSummary] = useState('');
  const [pendingKind, setPendingKind] = useState<InteractionKind | null>(null);

  const [promiseText, setPromiseText] = useState('');
  const [promiseDue, setPromiseDue] = useState('');

  const [giftDesc, setGiftDesc] = useState('');
  const [giftDirection, setGiftDirection] = useState<GiftDirection>('given');
  const [giftOccasion, setGiftOccasion] = useState('');
  const [giftAmount, setGiftAmount] = useState('');

  const [cadenceMode, setCadenceMode] = useState<string>('');
  const [customDays, setCustomDays] = useState('');
  const [cadenceEnabled, setCadenceEnabled] = useState(false);
  const [savingCadence, setSavingCadence] = useState(false);

  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  const loadTimeline = useCallback(
    async (page: number, append: boolean) => {
      if (!contactId) return;
      if (append) setLoadingMore(true);
      else setTimelineLoading(true);
      setTimelineError('');
      try {
        const res = await api.getRaw<TimelineEntry[]>(
          `/contacts/${contactId}/timeline?page=${page}&limit=${PAGE_LIMIT}`,
        );
        const data = Array.isArray(res.data) ? res.data : [];
        setEntries((prev) => (append ? [...prev, ...data] : data));
        setTimelinePage(page);
        const raw = (res.pagination as { totalPages?: unknown } | undefined)?.totalPages;
        const tp = Number(raw);
        setTotalPages(Number.isFinite(tp) && tp > 0 ? tp : 1);
      } catch (e) {
        setTimelineError(e instanceof Error ? e.message : '加载失败');
        if (!append) setEntries([]);
      } finally {
        if (append) setLoadingMore(false);
        else setTimelineLoading(false);
      }
    },
    [contactId],
  );

  useEffect(() => {
    if (!open || !contact) return;
    setSummary('');
    setPromiseText('');
    setPromiseDue('');
    setGiftDesc('');
    setGiftDirection('given');
    setGiftOccasion('');
    setGiftAmount('');
    setStatus('');
    setError('');
    setEntries([]);
    setTimelinePage(1);
    setTotalPages(1);
    setCadenceEnabled(Boolean(contact.cadence_enabled));
    const days = contact.cadence_days ?? null;
    if (days == null) {
      setCadenceMode('');
      setCustomDays('');
    } else if ((CADENCE_DAY_PRESETS as readonly number[]).includes(days)) {
      setCadenceMode(String(days));
      setCustomDays('');
    } else {
      setCadenceMode('custom');
      setCustomDays(String(days));
    }
    void loadTimeline(1, false);
    // Only re-initialise when the drawer opens or the contact changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contactId]);

  const cadenceDaysValue: number | null =
    cadenceMode === ''
      ? null
      : cadenceMode === 'custom'
        ? customDays.trim() === ''
          ? null
          : Number(customDays)
        : Number(cadenceMode);

  const effectiveLast = latestInteractionAt(entries) ?? contact?.last_contact_at ?? null;
  const nextDueAt =
    cadenceEnabled && cadenceDaysValue != null && Number.isFinite(cadenceDaysValue)
      ? computeNextDueAt(effectiveLast, cadenceDaysValue)
      : null;
  const isDue = Boolean(due) || isCadenceDue(nextDueAt);

  const relationshipLabel = contact
    ? resolveRelationshipOption(contact.relationship, contact.name, contact.nickname)?.label
    : undefined;

  const logInteraction = async (kind: InteractionKind) => {
    if (!contact || pendingKind) return;
    setPendingKind(kind);
    setError('');
    setStatus('');
    try {
      await api.post(`/contacts/${contact.id}/interactions`, {
        kind,
        summary: summary.trim() ? summary.trim() : undefined,
      });
      setSummary('');
      setStatus(`已记录「${interactionKindLabel(kind)}」`);
      await loadTimeline(1, false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败');
    } finally {
      setPendingKind(null);
    }
  };

  const addPromise = async () => {
    if (!contact || !promiseText.trim()) return;
    setError('');
    setStatus('');
    try {
      await api.post(`/contacts/${contact.id}/promises`, {
        text: promiseText.trim(),
        dueAt: promiseDue || null,
      });
      setPromiseText('');
      setPromiseDue('');
      setStatus('已记录约定');
      await loadTimeline(1, false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录约定失败');
    }
  };

  const addGift = async () => {
    if (!contact || !giftDesc.trim()) return;
    const trimmedAmount = giftAmount.trim();
    const parsedAmount = trimmedAmount === '' ? null : Math.round(Number(trimmedAmount) * 100);
    setError('');
    setStatus('');
    try {
      await api.post(`/contacts/${contact.id}/gifts`, {
        description: giftDesc.trim(),
        direction: giftDirection,
        occasion: giftOccasion.trim() || null,
        amountCents: parsedAmount != null && Number.isFinite(parsedAmount) ? parsedAmount : null,
      });
      setGiftDesc('');
      setGiftOccasion('');
      setGiftAmount('');
      setStatus('已记录礼物');
      await loadTimeline(1, false);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录礼物失败');
    }
  };

  const saveCadence = async () => {
    if (!contact) return;
    if (cadenceEnabled && cadenceMode === 'custom' && (cadenceDaysValue == null || cadenceDaysValue <= 0)) {
      setError('请输入大于 0 的自定义天数');
      return;
    }
    setSavingCadence(true);
    setError('');
    setStatus('');
    try {
      await api.put(`/contacts/${contact.id}`, {
        cadenceDays: cadenceDaysValue,
        cadenceEnabled,
      });
      setStatus('已保存联系节奏');
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    } finally {
      setSavingCadence(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="contact-detail-drawer"
        className="fixed inset-y-0 right-0 left-auto top-0 h-full max-h-none w-full max-w-xl translate-x-0 translate-y-0 overflow-y-auto overscroll-contain rounded-none p-5 sm:max-w-xl sm:rounded-none sm:p-7"
      >
        {contact && (
          <div className="space-y-5 pb-6">
            <DialogHeader>
              <div className="flex items-start gap-2 flex-wrap pr-10">
                <DialogTitle className="text-xl break-words">{contact.name}</DialogTitle>
                {isDue && (
                  <span
                    data-testid="contact-due-badge"
                    data-token="destructive"
                    className="inline-flex items-center rounded-full border border-destructive/40 bg-destructive/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-destructive"
                  >
                    该联系了
                  </span>
                )}
              </div>
              <div data-testid="contact-tags" className="flex flex-wrap gap-1.5">
                {relationshipLabel && <Badge variant="secondary" className="normal-case">{relationshipLabel}</Badge>}
                <Badge variant="outline" className="normal-case">
                  {relationshipCategoryLabel(getRelationshipCategory(contact))}
                </Badge>
                <Badge variant="outline" className="normal-case">称呼：{resolveContactGreetingName(contact)}</Badge>
              </div>
              <p className="text-xs text-hint">
                上次联系：{effectiveLast ? formatYmdLocal(effectiveLast) : '从未'}
                {nextDueAt ? ' · 下次联系：' : ''}
                {nextDueAt && (
                  <span data-testid="contact-next-due" className="font-semibold text-slate-900 dark:text-slate-100">
                    {formatYmdLocal(nextDueAt)}
                  </span>
                )}
              </p>
            </DialogHeader>

            {/* 联系节奏 */}
            <section
              aria-label="联系节奏"
              className="rounded-2xl p-3.5 space-y-3 ring-1 ring-black/5 dark:ring-white/10 bg-white/60 dark:bg-slate-900/50"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <CalendarClock className="w-4 h-4 text-primary-500" aria-hidden />
                  <div>
                    <p className="text-sm font-medium">联系节奏</p>
                    <p className="text-xs text-hint" data-testid="contact-cadence-label">
                      {formatCadenceLabel(cadenceDaysValue)}
                    </p>
                  </div>
                </div>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={cadenceEnabled}
                    onCheckedChange={setCadenceEnabled}
                    aria-label="启用节奏提醒"
                  />
                  启用
                </label>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <Select
                  aria-label="节奏周期"
                  value={cadenceMode}
                  onChange={(e) => setCadenceMode(e.target.value)}
                  className="sm:flex-1"
                >
                  <option value="">未设置</option>
                  {CADENCE_DAY_PRESETS.map((preset) => (
                    <option key={preset} value={String(preset)}>
                      {formatCadenceLabel(preset)}（{preset} 天）
                    </option>
                  ))}
                  <option value="custom">自定义</option>
                </Select>
                {cadenceMode === 'custom' && (
                  <Input
                    type="number"
                    min={1}
                    aria-label="自定义节奏天数"
                    placeholder="天数"
                    value={customDays}
                    onChange={(e) => setCustomDays(e.target.value)}
                    className="sm:w-28"
                  />
                )}
                <Button
                  variant="outline"
                  className="min-h-11"
                  onClick={saveCadence}
                  disabled={savingCadence}
                  aria-label="保存联系节奏"
                >
                  {savingCadence ? <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden /> : null}
                  保存
                </Button>
              </div>
            </section>

            {/* 记录联系（快捷动作） */}
            <section
              aria-label="记录联系"
              className="rounded-2xl p-3.5 space-y-3 ring-1 ring-black/5 dark:ring-white/10 bg-white/60 dark:bg-slate-900/50"
            >
              <p className="text-sm font-medium">记录联系</p>
              <Textarea
                aria-label="互动备注"
                placeholder="备注（可选，例如聊了些什么）"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                maxLength={2000}
                className="min-h-[64px]"
              />
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {INTERACTION_QUICK_ACTIONS.map((action) => {
                  const Icon = QUICK_ICON[action.kind];
                  return (
                    <Button
                      key={action.kind}
                      variant="outline"
                      className="min-h-11"
                      disabled={pendingKind !== null}
                      onClick={() => logInteraction(action.kind)}
                      aria-label={`记录联系：${action.label}`}
                    >
                      {pendingKind === action.kind ? (
                        <Loader2 className="w-4 h-4 mr-1 animate-spin" aria-hidden />
                      ) : (
                        <Icon className="w-4 h-4 mr-1" aria-hidden />
                      )}
                      {action.label}
                    </Button>
                  );
                })}
              </div>
            </section>

            {/* 记录约定 / 礼物（POST 均存在；约定只读渲染完成状态） */}
            <details className="rounded-2xl p-3.5 ring-1 ring-black/5 dark:ring-white/10 bg-white/60 dark:bg-slate-900/50">
              <summary className="text-sm font-medium cursor-pointer">记录约定</summary>
              <div className="space-y-2 mt-3">
                <Input
                  aria-label="约定内容"
                  placeholder="例如：答应帮对方带一本书"
                  value={promiseText}
                  onChange={(e) => setPromiseText(e.target.value)}
                  maxLength={2000}
                />
                <div className="flex gap-2">
                  <Input
                    type="date"
                    aria-label="约定截止日期"
                    value={promiseDue}
                    onChange={(e) => setPromiseDue(e.target.value)}
                  />
                  <Button
                    variant="outline"
                    className="min-h-11 shrink-0"
                    disabled={!promiseText.trim()}
                    onClick={addPromise}
                    aria-label="保存约定"
                  >
                    保存约定
                  </Button>
                </div>
                <p className="text-xs text-hint">约定完成后暂不支持在此标记（后端未提供完成接口）。</p>
              </div>
            </details>

            <details className="rounded-2xl p-3.5 ring-1 ring-black/5 dark:ring-white/10 bg-white/60 dark:bg-slate-900/50">
              <summary className="text-sm font-medium cursor-pointer">记录礼物</summary>
              <div className="space-y-2 mt-3">
                <Input
                  aria-label="礼物描述"
                  placeholder="例如：围巾"
                  value={giftDesc}
                  onChange={(e) => setGiftDesc(e.target.value)}
                  maxLength={500}
                />
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <Select
                    aria-label="礼物方向"
                    value={giftDirection}
                    onChange={(e) => setGiftDirection(e.target.value as GiftDirection)}
                  >
                    <option value="given">送出</option>
                    <option value="received">收到</option>
                  </Select>
                  <Input
                    aria-label="礼物场合"
                    placeholder="场合（可选）"
                    value={giftOccasion}
                    onChange={(e) => setGiftOccasion(e.target.value)}
                    maxLength={200}
                  />
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    aria-label="礼物金额"
                    placeholder="金额（元）"
                    value={giftAmount}
                    onChange={(e) => setGiftAmount(e.target.value)}
                  />
                </div>
                <Button
                  variant="outline"
                  className="min-h-11"
                  disabled={!giftDesc.trim()}
                  onClick={addGift}
                  aria-label="保存礼物"
                >
                  保存礼物
                </Button>
              </div>
            </details>

            {error && (
              <p role="alert" data-testid="contact-detail-error" className="text-sm text-destructive">
                {error}
              </p>
            )}
            {status && (
              <p role="status" data-testid="contact-detail-status" className="text-sm text-hint">
                {status}
              </p>
            )}

            <section aria-label="互动时间线" className="space-y-3">
              <h3 className="text-sm font-bold text-hint">时间线</h3>
              <ContactTimeline
                entries={entries}
                loading={timelineLoading}
                error={timelineError}
                hasMore={timelinePage < totalPages}
                loadingMore={loadingMore}
                onLoadMore={() => void loadTimeline(timelinePage + 1, true)}
                onRetry={() => void loadTimeline(1, false)}
              />
            </section>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
