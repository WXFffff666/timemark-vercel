import { useEffect, useState, type ReactNode } from 'react';
import { Send, Mail, Eye, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * 设置页「周期摘要」区块（checkbox 80）。
 *
 * - 偏好：启用 / 周期 / 收件人覆盖 / 包含区块 / 投递渠道，走 `GET|POST /config/digest`
 *   持久化到 `user_configs`（v46 列），与设置页其它区块同一套 glass-panel 样式。
 * - 「立即发送预览」先 `POST /digest/preview` 拿真实结构化数据，在弹窗中渲染，**发送前**即可核对；
 *   「立即发送」才 `POST /digest/send`。
 * - 无邮件渠道时预览照常渲染，并在弹窗与状态栏明确说明缺少哪一环（不静默失败）。
 * - 收件人/区块由后端清洗归一；空选择回退「全部区块」，绝不渲染空摘要。
 */

const EMAIL_TYPES = new Set(['resend', 'email', 'smtp']);

const SECTION_META = [
  { key: 'upcoming', label: '未来 30 天' },
  { key: 'overdue', label: '逾期事项' },
  { key: 'spend', label: '订阅与到期支出' },
  { key: 'habits', label: '习惯完成率' },
  { key: 'medications', label: '用药依从性' },
  { key: 'maintenance', label: '保养到期' },
  { key: 'goals', label: '目标进度' },
] as const;

const SECTION_KEYS = SECTION_META.map((s) => s.key);

interface DigestConfig {
  enabled: boolean;
  period: 'monthly' | 'yearly';
  recipients: string[];
  sections: string[] | null;
  channelAccountId: number | null;
  dailyEnabled?: boolean;
  dailyTime?: string;
  weeklyEnabled?: boolean;
  weeklyDay?: number;
  weeklyTime?: string;
}

interface AccountRow {
  id: number;
  type: string;
  name: string;
  is_active?: boolean;
}

interface DigestSendResult {
  emailed: boolean;
  skipped?: boolean;
  reason?: 'no_email_recipient' | 'no_email_channel';
  recipients?: string[];
}

interface PreviewUpcomingRow { id: number; name: string; type: string; date: string }
interface PreviewOverdueRow { kind: string; title: string; due: string; daysOverdue: number }
interface PreviewHabitRow { name: string; logged: number; target: number; rate: number }
interface PreviewMedicationRow { name: string; taken: number; skipped: number; missed: number; total: number; percentage: number }
interface PreviewMaintenanceRow { assetName: string; due: string; overdue: boolean }
interface PreviewGoalRow { title: string; status: string; progress: number | null; milestonesDone: number; milestonesTotal: number }

interface DigestPreview {
  period: 'monthly' | 'yearly';
  from: string;
  to: string;
  today: string;
  enabled: boolean;
  sections: string[];
  isEmpty: boolean;
  recipients: string[];
  recipientSource: 'override' | 'resolved' | 'none';
  channel: { id: number | null; name: string | null; type: string | null; configured: boolean };
  reason?: 'no_email_recipient' | 'no_email_channel';
  data: {
    upcoming: PreviewUpcomingRow[];
    overdue: PreviewOverdueRow[];
    spend: { byCurrency: Record<string, number>; onceByCurrency: Record<string, number>; onceCount: number };
    habits: PreviewHabitRow[];
    medications: { taken: number; skipped: number; missed: number; total: number; percentage: number; perMedication: PreviewMedicationRow[] };
    maintenance: PreviewMaintenanceRow[];
    goals: PreviewGoalRow[];
  };
}

interface StatusMessage { kind: 'ok' | 'warn' | 'error'; text: string }

function parseRecipients(text: string): string[] {
  return text
    .split(/[,，;；\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  return currency === 'CNY' ? `¥${amount}` : `${currency} ${amount}`;
}

function PreviewTable({ headers, rows }: { headers: string[]; rows: Array<Array<string | number>> }) {
  if (rows.length === 0) {
    return <p className="text-sm text-slate-400 px-1">无记录</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th key={h} className={`text-xs font-semibold text-slate-400 pb-1 ${i > 0 ? 'text-right' : 'text-left'}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, r) => (
            <tr key={r} className="border-t border-slate-100 dark:border-slate-800">
              {cells.map((cell, c) => (
                <td key={c} className={`py-1.5 text-slate-700 dark:text-slate-200 ${c > 0 ? 'text-right tabular-nums' : 'text-left'}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PreviewSection({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="rounded-2xl border border-slate-100 dark:border-slate-800 p-4">
      <h3 className="text-sm font-bold text-slate-900 dark:text-white mb-2">{label}</h3>
      {children}
    </section>
  );
}

export function DigestSettings() {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [period, setPeriod] = useState<'monthly' | 'yearly'>('monthly');
  const [recipients, setRecipients] = useState('');
  const [sections, setSections] = useState<string[]>([...SECTION_KEYS]);
  const [channelAccountId, setChannelAccountId] = useState<number | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  // v2.30 方向 A：日报/周报独立排程
  const [dailyEnabled, setDailyEnabled] = useState(false);
  const [dailyTime, setDailyTime] = useState('21:00');
  const [weeklyEnabled, setWeeklyEnabled] = useState(false);
  const [weeklyDay, setWeeklyDay] = useState(1);
  const [weeklyTime, setWeeklyTime] = useState('09:00');

  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  const [showPreview, setShowPreview] = useState(false);
  const [preview, setPreview] = useState<DigestPreview | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<DigestConfig>('/config/digest').catch(() => null),
      api.get<AccountRow[]>('/config/accounts').catch(() => []),
    ])
      .then(([cfg, accts]) => {
        if (cancelled) return;
        if (cfg) {
          setEnabled(cfg.enabled !== false);
          setPeriod(cfg.period === 'yearly' ? 'yearly' : 'monthly');
          setRecipients(Array.isArray(cfg.recipients) ? cfg.recipients.join(', ') : '');
          setSections(Array.isArray(cfg.sections) && cfg.sections.length > 0 ? cfg.sections : [...SECTION_KEYS]);
          setChannelAccountId(typeof cfg.channelAccountId === 'number' ? cfg.channelAccountId : null);
          setDailyEnabled(cfg.dailyEnabled === true);
          setDailyTime(typeof cfg.dailyTime === 'string' ? cfg.dailyTime : '21:00');
          setWeeklyEnabled(cfg.weeklyEnabled === true);
          setWeeklyDay(typeof cfg.weeklyDay === 'number' ? cfg.weeklyDay : 1);
          setWeeklyTime(typeof cfg.weeklyTime === 'string' ? cfg.weeklyTime : '09:00');
        }
        const list = Array.isArray(accts) ? accts.filter((a) => a.is_active !== false && EMAIL_TYPES.has(a.type)) : [];
        setAccounts(list);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggleSection = (key: string) => {
    setSections((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  const payload = () => ({
    enabled,
    period,
    recipients: parseRecipients(recipients),
    sections,
    channelAccountId,
    dailyEnabled,
    dailyTime,
    weeklyEnabled,
    weeklyDay,
    weeklyTime,
  });

  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      await api.post('/config/digest', payload());
      setStatus({ kind: 'ok', text: '摘要设置已保存' });
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const openPreview = async () => {
    setPreviewing(true);
    setStatus(null);
    try {
      const data = await api.post<DigestPreview>('/digest/preview', {
        period,
        sections,
        recipients: parseRecipients(recipients),
      });
      setPreview(data);
      setShowPreview(true);
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '预览失败' });
    } finally {
      setPreviewing(false);
    }
  };

  const sendNow = async () => {
    setSending(true);
    setStatus(null);
    try {
      const result = await api.post<DigestSendResult>('/digest/send', { period });
      if (result.emailed) {
        setStatus({ kind: 'ok', text: `摘要已发送${result.recipients?.length ? `：${result.recipients.join(', ')}` : ''}` });
      } else if (result.reason === 'no_email_channel') {
        setStatus({ kind: 'warn', text: '未发送：没有可用的邮件渠道，请先在「通知渠道」配置 Resend 或 SMTP。' });
      } else if (result.reason === 'no_email_recipient') {
        setStatus({ kind: 'warn', text: '未发送：没有可用的收件人邮箱，请填写收件人覆盖或通知默认邮箱。' });
      } else {
        setStatus({ kind: 'warn', text: '摘要已生成，但未发送邮件。' });
      }
    } catch (error) {
      setStatus({ kind: 'error', text: error instanceof Error ? error.message : '发送失败' });
    } finally {
      setSending(false);
    }
  };

  const previewSections = preview ? new Set(preview.sections) : new Set<string>();

  return (
    <section data-testid="digest-settings">
      <h2 className="text-sm font-bold text-slate-500 dark:text-slate-400 mb-3 px-4 uppercase tracking-wider flex items-center gap-2">
        <Send className="w-4 h-4" /> 周期摘要
      </h2>
      <div className="glass-panel rounded-[2.5rem] p-6 space-y-5 ring-1 ring-black/5 dark:ring-white/10">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          定期把「未来 30 天 / 逾期 / 支出 / 习惯 / 用药 / 保养 / 目标」渲染成一封图文摘要（含 PDF 附件）与一条收件箱消息。
          下方设置同时作用于定时任务与手动发送。
        </p>

        <div className="flex items-center justify-between gap-4 p-4 rounded-[2rem] bg-slate-50/60 dark:bg-white/5">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-2xl bg-sky-50 dark:bg-sky-900/30 text-sky-600 flex items-center justify-center shadow-inner border border-sky-100 dark:border-sky-800/50">
              <Mail size={22} />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900 dark:text-white">启用周期摘要</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">关闭后定时任务不再发送；手动「立即发送」仍可用</p>
            </div>
          </div>
          <Switch checked={enabled} onCheckedChange={setEnabled} aria-label="启用周期摘要" />
        </div>

        {/* v2.30 方向 A：AI 日报/周报独立排程（与月/年摘要共用收件人与渠道） */}
        <div className="space-y-3 p-4 rounded-[2rem] bg-slate-50/60 dark:bg-white/5">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">AI 日报</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">过去 24h 事件/提醒/习惯/用药速览，AI 生成自然语言叙述</p>
            </div>
            <Switch checked={dailyEnabled} onCheckedChange={setDailyEnabled} aria-label="启用 AI 日报" />
          </div>
          {dailyEnabled && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-slate-500 dark:text-slate-400 shrink-0">每天投递时刻</label>
              <input
                type="time"
                data-testid="digest-daily-time"
                aria-label="日报投递时刻"
                value={dailyTime}
                onChange={(e) => setDailyTime(e.target.value)}
                className="h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
              />
              <span className="text-xs text-slate-400">按你的本地时区到点后由定时任务投递（同一天不重复）</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-4 pt-2 border-t border-slate-200/60 dark:border-slate-700/50">
            <div>
              <h3 className="text-sm font-bold text-slate-900 dark:text-white">AI 周报</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">过去 7 天汇总 + 与上周的对比</p>
            </div>
            <Switch checked={weeklyEnabled} onCheckedChange={setWeeklyEnabled} aria-label="启用 AI 周报" />
          </div>
          {weeklyEnabled && (
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-slate-500 dark:text-slate-400 shrink-0">投递</label>
              <select
                data-testid="digest-weekly-day"
                aria-label="周报投递日"
                value={weeklyDay}
                onChange={(e) => setWeeklyDay(Number(e.target.value))}
                className="h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
              >
                <option value={1}>每周一</option>
                <option value={2}>每周二</option>
                <option value={3}>每周三</option>
                <option value={4}>每周四</option>
                <option value={5}>每周五</option>
                <option value={6}>每周六</option>
                <option value={0}>每周日</option>
              </select>
              <input
                type="time"
                data-testid="digest-weekly-time"
                aria-label="周报投递时刻"
                value={weeklyTime}
                onChange={(e) => setWeeklyTime(e.target.value)}
                className="h-9 px-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white"
              />
              <span className="text-xs text-slate-400">本地时区到点后投递（同一周期不重复）</span>
            </div>
          )}
          <p className="text-xs text-slate-400">日报/周报与月/年摘要共用下方收件人与投递渠道；AI 叙述受预算闸约束，AI 不可用时自动降级为纯统计文本。</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 block">摘要周期</label>
            <select
              data-testid="digest-period"
              aria-label="摘要周期"
              value={period}
              onChange={(e) => setPeriod(e.target.value === 'yearly' ? 'yearly' : 'monthly')}
              className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm w-full text-slate-900 dark:text-white"
            >
              <option value="monthly">月度（上一个自然月）</option>
              <option value="yearly">年度（上一个自然年）</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 block">投递渠道</label>
            <select
              data-testid="digest-channel"
              aria-label="投递渠道"
              value={channelAccountId ?? ''}
              onChange={(e) => setChannelAccountId(e.target.value ? Number(e.target.value) : null)}
              className="h-11 px-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm w-full text-slate-900 dark:text-white"
            >
              <option value="">自动（第一个可用邮件渠道）</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} · {a.type}</option>
              ))}
            </select>
            {accounts.length === 0 && (
              <p data-testid="digest-no-channel-hint" className="text-xs text-amber-600 dark:text-amber-400 mt-1">
                尚无邮件渠道，请先在「通知渠道」配置 Resend 或 SMTP
              </p>
            )}
          </div>
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 dark:text-slate-400 mb-1 block">收件人覆盖（留空则使用通知默认邮箱）</label>
          <Input
            data-testid="digest-recipients"
            aria-label="摘要收件人"
            placeholder="a@example.com, b@example.com"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
          <p className="text-xs text-slate-400 mt-1">多个用逗号分隔；仅接受完整邮箱地址，填写的地址优先于默认收件人。</p>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2 gap-3">
            <label className="text-xs font-semibold text-slate-500 dark:text-slate-400">包含的区块</label>
            <div className="flex gap-3">
              <button type="button" data-testid="digest-sections-all" onClick={() => setSections([...SECTION_KEYS])} className="text-xs text-primary-600 dark:text-primary-400">全选</button>
              <button type="button" data-testid="digest-sections-none" onClick={() => setSections([])} className="text-xs text-slate-500 dark:text-slate-400">清空</button>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {SECTION_META.map(({ key, label }) => {
              const active = sections.includes(key);
              return (
                <label
                  key={key}
                  data-testid={`digest-section-${key}`}
                  className={`flex items-center justify-center h-9 rounded-xl border text-sm cursor-pointer transition-colors ${active ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300' : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'}`}
                >
                  <input type="checkbox" className="sr-only" checked={active} onChange={() => toggleSection(key)} aria-label={`摘要区块 ${label}`} />
                  {label}
                </label>
              );
            })}
          </div>
          {sections.length === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-2">未选择任何区块；预览会回退为包含全部区块，避免生成空摘要。</p>
          )}
        </div>

        {status && (
          <p
            role="status"
            data-testid="digest-status"
            className={`text-sm ${status.kind === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : status.kind === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-red-500'}`}
          >
            {status.text}
          </p>
        )}

        <div className="flex flex-wrap gap-3 pt-1">
          <Button data-testid="digest-save" onClick={save} disabled={saving || loading}>
            {saving ? '保存中...' : '保存摘要设置'}
          </Button>
          <Button data-testid="digest-preview" variant="secondary" onClick={openPreview} disabled={previewing || loading}>
            <Eye size={16} className="mr-1" />
            {previewing ? '生成中...' : '立即发送预览'}
          </Button>
          <Button data-testid="digest-send" variant="outline" onClick={sendNow} disabled={sending || loading}>
            {sending ? '发送中...' : '立即发送'}
          </Button>
        </div>
      </div>

      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent data-testid="digest-preview-modal" className="glass-panel rounded-[2.5rem] max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-3 text-xl">
              <span className="p-2 bg-sky-50 dark:bg-sky-900/30 rounded-xl text-sky-600 dark:text-sky-400">
                <Eye size={18} />
              </span>
              摘要预览
            </DialogTitle>
          </DialogHeader>

          {preview ? (
            <div className="space-y-4" data-testid="digest-preview-body">
              <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                <Badge variant="secondary">{preview.period === 'yearly' ? '年度' : '月度'}</Badge>
                <span data-testid="digest-preview-range">{preview.from} 至 {preview.to}</span>
                <span>· 生成日期 {preview.today}</span>
                {!preview.enabled && <Badge variant="outline">定时任务已关闭</Badge>}
              </div>

              <div
                data-testid="digest-preview-status"
                className={`rounded-2xl border px-4 py-3 text-sm space-y-1 ${preview.reason ? 'border-amber-200 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-200' : 'border-emerald-200 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-800 dark:text-emerald-200'}`}
              >
                {preview.channel.configured ? (
                  <p className="flex items-center gap-2">
                    <CheckCircle2 size={16} /> 投递渠道：{preview.channel.name || preview.channel.type}（{preview.channel.type}）
                  </p>
                ) : (
                  <p data-testid="digest-preview-channel-missing" className="flex items-center gap-2">
                    <AlertTriangle size={16} /> 未配置可用的邮件渠道：请在「通知渠道」添加 Resend 或 SMTP 后重试。
                  </p>
                )}
                <p data-testid="digest-preview-recipients" className="flex items-center gap-2">
                  {preview.recipients.length > 0
                    ? `收件人（${preview.recipientSource === 'override' ? '覆盖' : '默认'}）：${preview.recipients.join(', ')}`
                    : '没有可用的收件人邮箱'}
                </p>
              </div>

              {preview.isEmpty ? (
                <p data-testid="digest-preview-empty" className="text-sm text-slate-500 dark:text-slate-400">本期无记录</p>
              ) : (
                <div className="space-y-3">
                  {previewSections.has('upcoming') && (
                    <PreviewSection label="未来 30 天" testId="digest-view-upcoming">
                      <PreviewTable headers={['事项', '类型', '日期']} rows={preview.data.upcoming.map((e) => [e.name, e.type, e.date])} />
                    </PreviewSection>
                  )}
                  {previewSections.has('overdue') && (
                    <PreviewSection label="逾期事项" testId="digest-view-overdue">
                      <PreviewTable headers={['类型', '事项', '到期', '逾期天数']} rows={preview.data.overdue.map((o) => [o.kind, o.title, o.due, o.daysOverdue])} />
                    </PreviewSection>
                  )}
                  {previewSections.has('spend') && (
                    <PreviewSection label="订阅与到期支出" testId="digest-view-spend">
                      <PreviewTable
                        headers={['项目', '金额']}
                        rows={[
                          ...Object.entries(preview.data.spend.byCurrency).map(([c, cents]) => [`周期折算 (${c})`, formatMoney(cents, c)]),
                          ...Object.entries(preview.data.spend.onceByCurrency).map(([c, cents]) => [`一次性支出 (${c})`, formatMoney(cents, c)]),
                        ]}
                      />
                    </PreviewSection>
                  )}
                  {previewSections.has('habits') && (
                    <PreviewSection label="习惯完成率" testId="digest-view-habits">
                      <PreviewTable headers={['习惯', '已完成', '目标', '完成率']} rows={preview.data.habits.map((h) => [h.name, h.logged, h.target, `${h.rate}%`])} />
                    </PreviewSection>
                  )}
                  {previewSections.has('medications') && (
                    <PreviewSection label="用药依从性" testId="digest-view-medications">
                      <PreviewTable headers={['药品', '已服', '跳过', '漏服', '依从率']} rows={preview.data.medications.perMedication.map((m) => [m.name, m.taken, m.skipped, m.missed, `${m.percentage}%`])} />
                    </PreviewSection>
                  )}
                  {previewSections.has('maintenance') && (
                    <PreviewSection label="保养到期" testId="digest-view-maintenance">
                      <PreviewTable headers={['资产', '到期', '状态']} rows={preview.data.maintenance.map((m) => [m.assetName, m.due, m.overdue ? '已逾期' : '临近'])} />
                    </PreviewSection>
                  )}
                  {previewSections.has('goals') && (
                    <PreviewSection label="目标进度" testId="digest-view-goals">
                      <PreviewTable headers={['目标', '状态', '进度', '里程碑']} rows={preview.data.goals.map((g) => [g.title, g.status, g.progress == null ? '—' : `${g.progress}%`, `${g.milestonesDone}/${g.milestonesTotal}`])} />
                    </PreviewSection>
                  )}
                </div>
              )}

              <p className="text-xs text-slate-400 flex items-center gap-1.5 pt-1">
                <RefreshCw size={12} /> 预览仅渲染，不会发送任何邮件或写入收件箱。
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-500 dark:text-slate-400">正在生成预览…</p>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
