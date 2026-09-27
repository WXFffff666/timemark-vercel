import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  CheckCircle2,
  Clock,
  Coffee,
  Download,
  Flame,
  Moon,
  Pencil,
  Pill,
  Plus,
  RefreshCw,
  SkipForward,
  Sun,
  Trash2,
  Utensils,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileBottomNav } from '@/components/MobileBottomNav';
import { ProfileSwitcher } from '@/components/ProfileSwitcher';
import { useSmartBack } from '@/hooks/useSmartBack';
import { api } from '@/lib/api';
import { useProfileStore } from '@/stores/profile.store';
import { useTimezoneStore } from '@/stores/timezone.store';
import {
  createMedicationSchema,
  dateStringInTimeZone,
  isoWeekStartYmd,
  MEDICATION_FORMS,
  shiftCalendarDays,
} from '@timemark/shared';
import type {
  AdherenceBucket,
  AdherenceReport,
  CreateMedicationInput,
  DoseStatus,
  LoggableDoseStatus,
  MedicationForm,
  MedicationRecord,
  RefillItem,
  TodayDose,
} from '@timemark/shared';

/**
 * 家庭用药页（D3，checkbox 75）。
 *
 * - 今日环：taken / skipped / missed 环 + 中心百分比；tap-to-log（服用 / 跳过）与稍后提醒。
 * - 时段分桶：早上 / 下午 / 晚上 / 夜间（按用户时区把 `scheduled_for` 归入时段）。
 * - 药品清单：每个计划时刻的每次用量。
 * - 补货提醒：库存低于阈值或可维持天数 < 7 时出现。
 * - 依从性标签页：周 / 月环 + 连胜，复用 Recharts。
 * - 档案感知：profile.store 的 profileId 透传到每个 API；切换后自动重载。
 * - `is_critical`（关键用药，可绕过免打扰）在创建 / 编辑表单中显式勾选。
 *
 * 只做提醒与记录，不做任何医疗建议或 AI 推断。
 */

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000/api' : '/api';

const FORM_LABELS: Record<MedicationForm, string> = {
  tablet: '片剂',
  capsule: '胶囊',
  liquid: '口服液',
  injection: '注射',
  patch: '贴片',
  drops: '滴剂',
  other: '其他',
};

const STATUS_META: Record<DoseStatus, { label: string; variant: 'success' | 'secondary' | 'destructive' | 'outline' }> = {
  taken: { label: '已服用', variant: 'success' },
  skipped: { label: '已跳过', variant: 'secondary' },
  missed: { label: '漏服', variant: 'destructive' },
  pending: { label: '待服', variant: 'outline' },
};

type BucketKey = 'morning' | 'afternoon' | 'evening' | 'night';

const BUCKET_ORDER: BucketKey[] = ['morning', 'afternoon', 'evening', 'night'];

const BUCKET_META: Record<BucketKey, { label: string; range: string; icon: typeof Sun }> = {
  morning: { label: '早上', range: '05:00 – 11:59', icon: Sun },
  afternoon: { label: '下午', range: '12:00 – 16:59', icon: Coffee },
  evening: { label: '晚上', range: '17:00 – 21:59', icon: Utensils },
  night: { label: '夜间', range: '22:00 – 04:59', icon: Moon },
};

const SCHEDULE_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: '周一' },
  { value: 2, label: '周二' },
  { value: 3, label: '周三' },
  { value: 4, label: '周四' },
  { value: 5, label: '周五' },
  { value: 6, label: '周六' },
  { value: 0, label: '周日' },
];

const RING_COLORS = {
  taken: '#10b981',
  skipped: '#f59e0b',
  missed: '#ef4444',
  pending: '#94a3b8',
} as const;

interface MedForm {
  name: string;
  dosage: string;
  form: MedicationForm;
  scheduleTimes: string[];
  scheduleDays: number[];
  startDate: string;
  endDate: string;
  stockQuantity: string;
  stockUnit: string;
  unitsPerDose: string;
  refillThreshold: string;
  prescriber: string;
  pharmacy: string;
  notes: string;
  isActive: boolean;
  isCritical: boolean;
}

function emptyForm(today: string): MedForm {
  return {
    name: '',
    dosage: '',
    form: 'tablet',
    scheduleTimes: [],
    scheduleDays: [],
    startDate: today,
    endDate: '',
    stockQuantity: '',
    stockUnit: '',
    unitsPerDose: '1',
    refillThreshold: '',
    prescriber: '',
    pharmacy: '',
    notes: '',
    isActive: true,
    isCritical: false,
  };
}

function toForm(med: MedicationRecord): MedForm {
  return {
    name: med.name,
    dosage: med.dosage ?? '',
    form: med.form,
    scheduleTimes: [...med.schedule_times],
    scheduleDays: [...(med.schedule_days ?? [])],
    startDate: med.start_date,
    endDate: med.end_date ?? '',
    stockQuantity: med.stock_quantity == null ? '' : String(med.stock_quantity),
    stockUnit: med.stock_unit ?? '',
    unitsPerDose: String(med.units_per_dose),
    refillThreshold: med.refill_threshold == null ? '' : String(med.refill_threshold),
    prescriber: med.prescriber ?? '',
    pharmacy: med.pharmacy ?? '',
    notes: med.notes ?? '',
    isActive: med.is_active,
    isCritical: med.is_critical,
  };
}

function toNumberOrNull(value: string): number | null {
  const text = value.trim();
  if (text === '') return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function buildPayload(form: MedForm, profileId: number | null): CreateMedicationInput {
  const units = toNumberOrNull(form.unitsPerDose);
  return {
    name: form.name.trim(),
    dosage: form.dosage.trim() || null,
    form: form.form,
    scheduleTimes: form.scheduleTimes,
    scheduleDays: form.scheduleDays.length > 0 ? [...form.scheduleDays].sort((a, b) => a - b) : null,
    startDate: form.startDate,
    endDate: form.endDate.trim() || null,
    stockQuantity: toNumberOrNull(form.stockQuantity),
    stockUnit: form.stockUnit.trim() || null,
    unitsPerDose: units != null ? units : 1,
    refillThreshold: toNumberOrNull(form.refillThreshold),
    prescriber: form.prescriber.trim() || null,
    pharmacy: form.pharmacy.trim() || null,
    notes: form.notes.trim() || null,
    isActive: form.isActive,
    isCritical: form.isCritical,
    profileId,
  };
}

function formatDoseAmount(units: number | null | undefined, unit: string | null): string {
  const amount = units == null || !Number.isFinite(Number(units)) ? 1 : Number(units);
  return unit ? `${amount} ${unit}` : String(amount);
}

function hourInTimeZone(iso: string, timeZone: string): number {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return 0;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    return Number.isFinite(hour) ? ((hour % 24) + 24) % 24 : 0;
  } catch {
    return date.getHours();
  }
}

function bucketKeyForHour(hour: number): BucketKey {
  if (hour >= 5 && hour <= 11) return 'morning';
  if (hour >= 12 && hour <= 16) return 'afternoon';
  if (hour >= 17 && hour <= 21) return 'evening';
  return 'night';
}

function formatTimeFromIso(iso: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  } catch {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }
}

function adherenceRange(period: 'week' | 'month', today: string): [string, string] {
  if (period === 'week') {
    const from = isoWeekStartYmd(today) ?? today;
    return [from, shiftCalendarDays(from, 6) ?? today];
  }
  const from = `${today.slice(0, 7)}-01`;
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const to = `${today.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
  return [from, to];
}

function normalizeBucket(raw: unknown): AdherenceBucket | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bucket = raw as Partial<AdherenceBucket>;
  if (typeof bucket.taken !== 'number' || typeof bucket.total !== 'number') return null;
  return {
    taken: bucket.taken,
    skipped: typeof bucket.skipped === 'number' ? bucket.skipped : 0,
    missed: typeof bucket.missed === 'number' ? bucket.missed : 0,
    total: bucket.total,
    percentage: typeof bucket.percentage === 'number' ? bucket.percentage : 0,
    currentStreak: typeof bucket.currentStreak === 'number' ? bucket.currentStreak : 0,
  };
}

function normalizeReport(raw: unknown, from: string, to: string): AdherenceReport | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Partial<AdherenceReport>;
  const overall = normalizeBucket(obj.overall);
  if (!overall) return null;
  const medications = Array.isArray(obj.medications)
    ? obj.medications
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const row = entry as { medicationId?: unknown; name?: unknown };
          const bucket = normalizeBucket(entry);
          if (!bucket || typeof row.medicationId !== 'number') return null;
          return { medicationId: row.medicationId, name: typeof row.name === 'string' ? row.name : '', ...bucket };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null)
    : [];
  return { from: typeof obj.from === 'string' ? obj.from : from, to: typeof obj.to === 'string' ? obj.to : to, overall, medications };
}

async function fetchReport(format: 'html' | 'csv' | 'pdf', from: string, to: string, profileId: number | null): Promise<void> {
  const params = new URLSearchParams({ from, to, format });
  if (profileId != null) params.set('profileId', String(profileId));
  const token = localStorage.getItem('accessToken') || sessionStorage.getItem('accessToken');
  const response = await fetch(`${API_BASE}/medications/report?${params.toString()}`, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `medications-${from}_${to}.${format}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function Medications() {
  const navigate = useNavigate();
  const goBack = useSmartBack('/dashboard');
  const profileId = useProfileStore((state) => state.profileId);
  const timezone = useTimezoneStore((state) => state.timezone);

  const [tab, setTab] = useState<'today' | 'adherence'>('today');
  const [period, setPeriod] = useState<'week' | 'month'>('week');

  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [todayDoses, setTodayDoses] = useState<TodayDose[]>([]);
  const [refills, setRefills] = useState<RefillItem[]>([]);
  const [report, setReport] = useState<AdherenceReport | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busyDoseId, setBusyDoseId] = useState<number | null>(null);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<MedForm>(emptyForm(dateStringInTimeZone(new Date(), timezone)));
  const [timeDraft, setTimeDraft] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const [reportFormat, setReportFormat] = useState<'html' | 'csv' | 'pdf'>('html');
  const [downloading, setDownloading] = useState(false);

  const today = dateStringInTimeZone(new Date(), timezone);
  const profileQuery = profileId != null ? `&profileId=${profileId}` : '';

  const loadToday = useCallback(async () => {
    const [meds, doses, refillItems] = await Promise.all([
      api.get<MedicationRecord[]>(`/medications?active=true${profileQuery}`),
      api.get<TodayDose[]>(`/medications/today${profileQuery ? `?profileId=${profileId}` : ''}`),
      api.get<RefillItem[]>(`/medications/refills${profileQuery ? `?profileId=${profileId}` : ''}`),
    ]);
    setMedications(Array.isArray(meds) ? meds : []);
    setTodayDoses(Array.isArray(doses) ? doses : []);
    setRefills(Array.isArray(refillItems) ? refillItems : []);
  }, [profileId, profileQuery]);

  const loadAdherence = useCallback(async () => {
    const [from, to] = adherenceRange(period, today);
    const data = await api.get<AdherenceReport>(`/medications/adherence?from=${from}&to=${to}${profileQuery}`);
    setReport(normalizeReport(data, from, to));
  }, [period, today, profileQuery]);

  const refreshAll = useCallback(async () => {
    setError('');
    try {
      await Promise.all([loadToday(), loadAdherence()]);
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  }, [loadToday, loadAdherence]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([loadToday(), loadAdherence()])
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadToday, loadAdherence]);

  const ring = useMemo(() => {
    const counts = { taken: 0, skipped: 0, missed: 0, pending: 0 };
    for (const dose of todayDoses) counts[dose.status] += 1;
    const total = todayDoses.length;
    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
    return {
      ...counts,
      total,
      takenPct: pct(counts.taken),
      skippedPct: pct(counts.skipped),
      missedPct: pct(counts.missed),
    };
  }, [todayDoses]);

  const ringData = useMemo(() => {
    const segments = [
      { key: 'taken', name: '已服用', value: ring.taken, color: RING_COLORS.taken },
      { key: 'skipped', name: '已跳过', value: ring.skipped, color: RING_COLORS.skipped },
      { key: 'missed', name: '漏服', value: ring.missed, color: RING_COLORS.missed },
      { key: 'pending', name: '待服', value: ring.pending, color: RING_COLORS.pending },
    ].filter((segment) => segment.value > 0);
    return segments.length > 0 ? segments : [{ key: 'empty', name: '无计划', value: 1, color: '#e2e8f0' }];
  }, [ring]);

  const grouped = useMemo(() => {
    const map: Record<BucketKey, TodayDose[]> = { morning: [], afternoon: [], evening: [], night: [] };
    for (const dose of todayDoses) {
      map[bucketKeyForHour(hourInTimeZone(dose.scheduled_for, timezone))].push(dose);
    }
    return map;
  }, [todayDoses, timezone]);

  const adherenceRangeLabel = useMemo(() => {
    const [from, to] = adherenceRange(period, today);
    return `${from} ~ ${to}`;
  }, [period, today]);

  const logDose = async (dose: TodayDose, nextStatus: LoggableDoseStatus) => {
    setError('');
    setStatus('');
    setBusyDoseId(dose.id);
    try {
      await api.post(`/doses/${dose.id}/log`, { status: nextStatus });
      setStatus(nextStatus === 'taken' ? `已记录「${dose.medication.name}」` : `已跳过「${dose.medication.name}」`);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败');
    } finally {
      setBusyDoseId(null);
    }
  };

  const snoozeDose = async (dose: TodayDose) => {
    setError('');
    setStatus('');
    setBusyDoseId(dose.id);
    try {
      await api.post(`/doses/${dose.id}/snooze`);
      setStatus(`已为「${dose.medication.name}」设置 10 分钟后提醒`);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : '稍后提醒失败');
    } finally {
      setBusyDoseId(null);
    }
  };

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm(dateStringInTimeZone(new Date(), timezone)));
    setTimeDraft('');
    setFieldErrors({});
    setOpen(true);
  };

  const openEdit = (med: MedicationRecord) => {
    setEditingId(med.id);
    setForm(toForm(med));
    setTimeDraft('');
    setFieldErrors({});
    setOpen(true);
  };

  const addTime = () => {
    const value = timeDraft.trim();
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return;
    setForm((prev) => ({
      ...prev,
      scheduleTimes: prev.scheduleTimes.includes(value)
        ? prev.scheduleTimes
        : [...prev.scheduleTimes, value].sort(),
    }));
    setTimeDraft('');
  };

  const removeTime = (value: string) => {
    setForm((prev) => ({ ...prev, scheduleTimes: prev.scheduleTimes.filter((t) => t !== value) }));
  };

  const toggleScheduleDay = (value: number) => {
    setForm((prev) => ({
      ...prev,
      scheduleDays: prev.scheduleDays.includes(value)
        ? prev.scheduleDays.filter((day) => day !== value)
        : [...prev.scheduleDays, value].sort((a, b) => a - b),
    }));
  };

  const save = async () => {
    setFieldErrors({});
    const payload = buildPayload(form, profileId);
    const parsed = createMedicationSchema.safeParse(payload);
    if (!parsed.success) {
      const nextErrors: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const key = String(issue.path[0] ?? 'form');
        if (!nextErrors[key]) nextErrors[key] = issue.message;
      }
      setFieldErrors(nextErrors);
      return;
    }
    setSaving(true);
    try {
      if (editingId != null) {
        await api.patch<MedicationRecord>(`/medications/${editingId}`, parsed.data);
        setStatus('药品已更新');
      } else {
        await api.post<MedicationRecord>('/medications', parsed.data);
        setStatus('药品已创建');
      }
      setOpen(false);
      await refreshAll();
    } catch (e) {
      setFieldErrors({ form: e instanceof Error ? e.message : '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (med: MedicationRecord) => {
    if (!window.confirm(`确定删除「${med.name}」？`)) return;
    setError('');
    try {
      await api.delete(`/medications/${med.id}`);
      setStatus(`已删除「${med.name}」`);
      await refreshAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const downloadReport = async () => {
    setError('');
    setStatus('');
    setDownloading(true);
    const [from, to] = adherenceRange(period, today);
    try {
      await fetchReport(reportFormat, from, to, profileId);
      setStatus(`报告已下载（${reportFormat.toUpperCase()}）`);
    } catch (e) {
      if (reportFormat === 'pdf') {
        try {
          await fetchReport('html', from, to, profileId);
          setStatus('PDF 暂不可用，已改为下载 HTML 报告');
        } catch (fallbackError) {
          setError(fallbackError instanceof Error ? fallbackError.message : '报告下载失败');
        }
      } else {
        setError(e instanceof Error ? e.message : '报告下载失败');
      }
    } finally {
      setDownloading(false);
    }
  };

  const adherenceChartData = useMemo(() => {
    if (!report) return [];
    const segments = [
      { key: 'taken', name: '已服用', value: report.overall.taken, color: RING_COLORS.taken },
      { key: 'skipped', name: '已跳过', value: report.overall.skipped, color: RING_COLORS.skipped },
      { key: 'missed', name: '漏服', value: report.overall.missed, color: RING_COLORS.missed },
    ].filter((segment) => segment.value > 0);
    return segments.length > 0 ? segments : [{ key: 'empty', name: '无记录', value: 1, color: '#e2e8f0' }];
  }, [report]);

  return (
    <div className="min-h-screen pb-24 overflow-x-hidden">
      <header className="sticky top-4 z-40 px-4 max-w-4xl mx-auto" role="banner" aria-label="用药页顶部导航">
        <div className="glass-panel rounded-3xl px-3 py-2.5 flex flex-wrap items-center gap-2 ring-1 ring-black/5 dark:ring-white/10">
          <Button variant="ghost" size="icon" className="rounded-full min-h-11 min-w-11" onClick={goBack} aria-label="返回上一页">
            <ArrowLeft size={20} aria-hidden />
          </Button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold truncate flex items-center gap-2">
              <Pill className="w-5 h-5 text-primary-500 shrink-0" aria-hidden />
              用药提醒
            </h1>
            <p className="text-xs text-hint truncate">今日计划 · 按时记录 · 补货提醒</p>
          </div>
          <ProfileSwitcher />
          <Button
            variant="ghost"
            size="icon"
            className="rounded-full min-h-11 min-w-11"
            onClick={() => void refreshAll()}
            aria-label="刷新用药数据"
          >
            <RefreshCw className="w-4 h-4" aria-hidden />
          </Button>
          <Button onClick={openCreate} className="rounded-full min-h-11" aria-label="新建药品">
            <Plus className="w-4 h-4 mr-1" aria-hidden />
            新建
          </Button>
        </div>
      </header>

      <main id="main-content" className="max-w-4xl mx-auto px-4 py-6 space-y-6" tabIndex={-1}>
        {error && (
          <p className="text-sm text-destructive glass-panel rounded-2xl px-4 py-3" role="alert">{error}</p>
        )}
        {status && (
          <p className="text-sm text-hint glass-panel rounded-2xl px-4 py-3" role="status">{status}</p>
        )}

        {loading ? (
          <p className="text-hint text-sm" role="status">加载中…</p>
        ) : medications.length === 0 && todayDoses.length === 0 ? (
          <div data-testid="medication-empty" className="text-center py-16 glass-panel rounded-3xl">
            <Pill className="w-12 h-12 mx-auto text-slate-300 dark:text-slate-600 mb-3" aria-hidden />
            <p className="font-semibold text-slate-700 dark:text-slate-200">还没有用药计划</p>
            <p className="text-sm text-hint mt-1">添加药品与服药时刻，按时记录每一次剂量</p>
            <Button className="mt-4 rounded-full" variant="outline" onClick={openCreate}>
              新建药品
            </Button>
          </div>
        ) : (
          <Tabs value={tab} onValueChange={(value) => setTab(value === 'adherence' ? 'adherence' : 'today')}>
            <TabsList aria-label="用药视图" className="glass-panel rounded-2xl h-auto p-1 w-full sm:w-auto">
              <TabsTrigger value="today" className="min-h-10 rounded-xl flex-1 sm:flex-none">今日</TabsTrigger>
              <TabsTrigger value="adherence" className="min-h-10 rounded-xl flex-1 sm:flex-none">依从性</TabsTrigger>
            </TabsList>

            <TabsContent value="today" className="space-y-6 mt-4">
              <section aria-label="今日服药环" className="glass-panel rounded-3xl p-4 ring-1 ring-black/5 dark:ring-white/10">
                <div className="flex flex-col sm:flex-row items-center gap-4">
                  <div
                    data-testid="medication-ring"
                    data-taken={ring.taken}
                    data-skipped={ring.skipped}
                    data-missed={ring.missed}
                    data-pending={ring.pending}
                    data-total={ring.total}
                    data-taken-pct={ring.takenPct}
                    data-skipped-pct={ring.skippedPct}
                    data-missed-pct={ring.missedPct}
                    className="relative w-full max-w-[220px] h-[220px] mx-auto shrink-0"
                  >
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie
                          data={ringData}
                          dataKey="value"
                          nameKey="name"
                          cx="50%"
                          cy="50%"
                          innerRadius="68%"
                          outerRadius="100%"
                          startAngle={90}
                          endAngle={-270}
                          stroke="none"
                          isAnimationActive={false}
                        >
                          {ringData.map((segment) => (
                            <Cell key={segment.key} fill={segment.color} />
                          ))}
                        </Pie>
                        <Tooltip />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                      <span className="text-3xl font-extrabold tabular-nums text-slate-900 dark:text-white">{ring.takenPct}%</span>
                      <span className="text-[11px] text-hint">已服用 {ring.taken}/{ring.total}</span>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 w-full space-y-3">
                    <div className="flex flex-wrap gap-x-4 gap-y-2">
                      {([
                        ['taken', '已服用', RING_COLORS.taken],
                        ['skipped', '已跳过', RING_COLORS.skipped],
                        ['missed', '漏服', RING_COLORS.missed],
                        ['pending', '待服', RING_COLORS.pending],
                      ] as const).map(([key, label, color]) => (
                        <div key={key} className="flex items-center gap-2 text-sm">
                          <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: color }} aria-hidden />
                          <span className="text-hint">{label}</span>
                          <span
                            data-testid={`ring-legend-${key}`}
                            className="font-semibold tabular-nums text-slate-800 dark:text-slate-200"
                          >
                            {ring[key]}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="text-xs text-hint">
                      共 {ring.total} 次计划剂量 · {today}
                    </p>
                  </div>
                </div>
              </section>

              <section aria-label="按时段查看今日剂量" className="space-y-3">
                {BUCKET_ORDER.map((key) => {
                  const meta = BUCKET_META[key];
                  const Icon = meta.icon;
                  const doses = grouped[key];
                  return (
                    <div
                      key={key}
                      data-testid={`bucket-${key}`}
                      data-count={doses.length}
                      className="glass-panel rounded-2xl p-3 ring-1 ring-black/5 dark:ring-white/10"
                    >
                      <div className="flex items-center gap-2 mb-2">
                        <Icon className="w-4 h-4 text-primary-500 shrink-0" aria-hidden />
                        <h2 className="text-sm font-bold">{meta.label}</h2>
                        <span className="text-[11px] text-hint">{meta.range}</span>
                        <span className="ml-auto text-xs text-hint tabular-nums">{doses.length} 次</span>
                      </div>
                      {doses.length === 0 ? (
                        <p className="text-xs text-hint px-1 py-1">该时段无计划剂量</p>
                      ) : (
                        <ul className="space-y-2">
                          {doses.map((dose) => {
                            const meta = STATUS_META[dose.status];
                            const settled = dose.status !== 'pending';
                            return (
                              <li
                                key={dose.id}
                                data-testid={`dose-row-${dose.id}`}
                                className="flex flex-wrap items-center gap-2 rounded-xl bg-white/50 dark:bg-white/5 px-3 py-2"
                              >
                                <span className="inline-flex items-center gap-1 text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-200 min-w-[3.25rem]">
                                  <Clock className="w-3.5 h-3.5" aria-hidden />
                                  {formatTimeFromIso(dose.scheduled_for, timezone)}
                                </span>
                                <span className="flex-1 min-w-0">
                                  <span className="block text-sm font-semibold truncate">{dose.medication.name}</span>
                                  <span className="block text-[11px] text-hint truncate">
                                    {formatDoseAmount(dose.medication.units_per_dose, dose.medication.stock_unit)}
                                    {dose.medication.dosage ? ` · ${dose.medication.dosage}` : ''}
                                  </span>
                                </span>
                                {dose.medication.is_critical && (
                                  <Badge variant="destructive" className="text-[10px]">关键</Badge>
                                )}
                                <Badge data-testid={`dose-status-${dose.id}`} data-status={dose.status} variant={meta.variant} className="text-[10px]">
                                  {meta.label}
                                </Badge>
                                {!settled && (
                                  <span className="flex items-center gap-1">
                                    <Button
                                      data-testid={`dose-taken-${dose.id}`}
                                      size="sm"
                                      className="min-h-9"
                                      disabled={busyDoseId === dose.id}
                                      onClick={() => void logDose(dose, 'taken')}
                                      aria-label={`记录 ${dose.medication.name} 已服用`}
                                    >
                                      <CheckCircle2 className="w-4 h-4 mr-1" aria-hidden />
                                      服用
                                    </Button>
                                    <Button
                                      data-testid={`dose-skipped-${dose.id}`}
                                      size="sm"
                                      variant="outline"
                                      className="min-h-9"
                                      disabled={busyDoseId === dose.id}
                                      onClick={() => void logDose(dose, 'skipped')}
                                      aria-label={`记录 ${dose.medication.name} 已跳过`}
                                    >
                                      <SkipForward className="w-4 h-4 mr-1" aria-hidden />
                                      跳过
                                    </Button>
                                    <Button
                                      data-testid={`dose-snooze-${dose.id}`}
                                      size="sm"
                                      variant="ghost"
                                      className="min-h-9"
                                      disabled={busyDoseId === dose.id}
                                      onClick={() => void snoozeDose(dose)}
                                      aria-label={`稍后提醒 ${dose.medication.name}`}
                                    >
                                      <Clock className="w-4 h-4 mr-1" aria-hidden />
                                      稍后
                                    </Button>
                                  </span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  );
                })}
              </section>

              {refills.length > 0 && (
                <section aria-label="补货提醒" data-testid="refill-section" className="glass-panel rounded-2xl p-3 ring-1 ring-black/5 dark:ring-white/10">
                  <div className="flex items-center gap-2 mb-2">
                    <AlertTriangle className="w-4 h-4 text-amber-500" aria-hidden />
                    <h2 className="text-sm font-bold">补货提醒</h2>
                    <Badge variant="destructive" className="ml-auto text-[10px]">{refills.length}</Badge>
                  </div>
                  <ul className="space-y-2">
                    {refills.map((item) => (
                      <li
                        key={item.medicationId}
                        data-testid={`refill-warning-${item.medicationId}`}
                        data-reason={item.reason}
                        className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50/70 dark:bg-amber-500/10 px-3 py-2"
                      >
                        <span className="text-sm font-semibold truncate flex-1 min-w-0">{item.name}</span>
                        <span className="text-xs text-hint">
                          剩余 {item.stockQuantity}
                          {item.stockUnit ? ` ${item.stockUnit}` : ''}
                          {item.refillThreshold != null ? ` · 阈值 ${item.refillThreshold}` : ''}
                          {item.daysOfSupply != null ? ` · 约 ${item.daysOfSupply} 天` : ''}
                        </span>
                        <Badge variant="destructive" className="text-[10px]">需要补货</Badge>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <section aria-label="我的药品" className="space-y-2">
                <h2 className="text-sm font-bold px-1 text-hint">我的药品 · {medications.length}</h2>
                {medications.length === 0 ? (
                  <p className="text-sm text-hint glass-panel rounded-2xl px-4 py-3">还没有药品</p>
                ) : (
                  medications.map((med) => (
                    <div
                      key={med.id}
                      data-testid={`med-row-${med.id}`}
                      className="glass-panel rounded-2xl px-3 py-3 ring-1 ring-black/5 dark:ring-white/10"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate min-w-0">{med.name}</span>
                        {med.is_critical && <Badge variant="destructive" className="text-[10px]">关键</Badge>}
                        {!med.is_active && <Badge variant="outline" className="text-[10px]">已停用</Badge>}
                        <Badge variant="secondary" className="text-[10px]">{FORM_LABELS[med.form]}</Badge>
                        <span className="ml-auto flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11"
                            onClick={() => openEdit(med)}
                            aria-label={`编辑 ${med.name}`}
                          >
                            <Pencil className="w-4 h-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="min-h-11 min-w-11"
                            onClick={() => void remove(med)}
                            aria-label={`删除 ${med.name}`}
                          >
                            <Trash2 className="w-4 h-4 text-destructive" aria-hidden />
                          </Button>
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {med.schedule_times.length === 0 ? (
                          <Badge variant="outline" className="text-[10px]">按需（PRN）</Badge>
                        ) : (
                          med.schedule_times.map((time) => (
                            <span
                              key={time}
                              className="inline-flex items-center gap-1 rounded-lg bg-white/60 dark:bg-white/10 px-2 py-1 text-[11px] font-semibold tabular-nums"
                            >
                              <Clock className="w-3 h-3" aria-hidden />
                              {time} · {formatDoseAmount(med.units_per_dose, med.stock_unit)}
                            </span>
                          ))
                        )}
                      </div>
                      {(med.dosage || med.stock_quantity != null || med.prescriber) && (
                        <p className="text-[11px] text-hint mt-2 truncate">
                          {[
                            med.dosage,
                            med.stock_quantity != null
                              ? `库存 ${med.stock_quantity}${med.stock_unit ? ` ${med.stock_unit}` : ''}`
                              : null,
                            med.prescriber ? `医师 ${med.prescriber}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </section>
            </TabsContent>

            <TabsContent value="adherence" className="space-y-6 mt-4">
              <section aria-label="依从性统计" className="glass-panel rounded-3xl p-4 ring-1 ring-black/5 dark:ring-white/10">
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <h2 className="text-sm font-bold">依从性</h2>
                  <span className="text-xs text-hint">{adherenceRangeLabel}</span>
                  <span className="ml-auto inline-flex items-center rounded-xl bg-white/60 dark:bg-white/10 p-0.5">
                    {(['week', 'month'] as const).map((value) => (
                      <button
                        key={value}
                        type="button"
                        data-testid={`adherence-period-${value}`}
                        aria-pressed={period === value}
                        onClick={() => setPeriod(value)}
                        className={`min-h-9 px-3 rounded-lg text-xs font-semibold transition-colors ${
                          period === value
                            ? 'bg-primary text-primary-foreground'
                            : 'text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        {value === 'week' ? '本周' : '本月'}
                      </button>
                    ))}
                  </span>
                </div>

                {!report ? (
                  <p className="text-sm text-hint py-8 text-center">暂无依从性数据</p>
                ) : (
                  <div className="flex flex-col sm:flex-row items-center gap-4">
                    <div
                      data-testid="adherence-donut"
                      data-taken={report.overall.taken}
                      data-skipped={report.overall.skipped}
                      data-missed={report.overall.missed}
                      data-total={report.overall.total}
                      data-percentage={report.overall.percentage}
                      className="relative w-full max-w-[200px] h-[200px] mx-auto shrink-0"
                    >
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={adherenceChartData}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius="62%"
                            outerRadius="100%"
                            startAngle={90}
                            endAngle={-270}
                            stroke="none"
                            isAnimationActive={false}
                          >
                            {adherenceChartData.map((segment) => (
                              <Cell key={segment.key} fill={segment.color} />
                            ))}
                          </Pie>
                          <Tooltip />
                        </PieChart>
                      </ResponsiveContainer>
                      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                        <span className="text-2xl font-extrabold tabular-nums text-slate-900 dark:text-white">
                          {report.overall.percentage}%
                        </span>
                        <span className="text-[11px] text-hint">{report.overall.taken}/{report.overall.total}</span>
                      </div>
                    </div>
                    <div className="flex-1 min-w-0 w-full space-y-3">
                      <div
                        data-testid="adherence-streak"
                        data-streak={report.overall.currentStreak}
                        className="inline-flex items-center gap-2"
                      >
                        <Flame className="w-4 h-4 text-primary-500" aria-hidden />
                        <span className="text-sm font-bold text-primary-600 dark:text-primary-400">
                          连续 {report.overall.currentStreak} 天全部服用
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-2 text-sm">
                        <span className="text-hint">已服用 <b className="text-slate-800 dark:text-slate-200 tabular-nums">{report.overall.taken}</b></span>
                        <span className="text-hint">已跳过 <b className="text-slate-800 dark:text-slate-200 tabular-nums">{report.overall.skipped}</b></span>
                        <span className="text-hint">漏服 <b className="text-slate-800 dark:text-slate-200 tabular-nums">{report.overall.missed}</b></span>
                        <span className="text-hint">合计 <b className="text-slate-800 dark:text-slate-200 tabular-nums">{report.overall.total}</b></span>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Select
                          aria-label="报告格式"
                          value={reportFormat}
                          onChange={(e) => setReportFormat(e.target.value as 'html' | 'csv' | 'pdf')}
                          className="h-11 w-auto min-w-[7rem]"
                        >
                          <option value="html">HTML</option>
                          <option value="csv">CSV</option>
                          <option value="pdf">PDF</option>
                        </Select>
                        <Button
                          data-testid="download-report"
                          className="min-h-11"
                          disabled={downloading}
                          onClick={() => void downloadReport()}
                          aria-label="下载依从性报告"
                        >
                          {downloading ? (
                            <RefreshCw className="w-4 h-4 mr-1 animate-spin" aria-hidden />
                          ) : (
                            <Download className="w-4 h-4 mr-1" aria-hidden />
                          )}
                          {downloading ? '生成中…' : '下载报告'}
                        </Button>
                      </div>
                      <p className="text-[11px] text-hint inline-flex items-center gap-1">
                        <CalendarClock className="w-3.5 h-3.5" aria-hidden />
                        报告包含患者档案、药品清单、每日依从性与补货状态
                      </p>
                    </div>
                  </div>
                )}
              </section>

              {report && report.medications.length > 0 && (
                <section aria-label="各药品依从性" className="space-y-2">
                  <h2 className="text-sm font-bold px-1 text-hint">各药品</h2>
                  {report.medications.map((row) => (
                    <div
                      key={row.medicationId}
                      data-testid={`adherence-row-${row.medicationId}`}
                      className="glass-panel rounded-2xl px-3 py-3 flex flex-wrap items-center gap-2 ring-1 ring-black/5 dark:ring-white/10"
                    >
                      <span className="font-semibold truncate flex-1 min-w-0">{row.name}</span>
                      <Badge variant="secondary" className="text-[10px] tabular-nums">{row.percentage}%</Badge>
                      <span className="text-xs text-hint tabular-nums">
                        {row.taken}/{row.total} · 连 {row.currentStreak} 天
                      </span>
                    </div>
                  ))}
                </section>
              )}
            </TabsContent>
          </Tabs>
        )}

        <p className="text-[11px] text-hint text-center">
          <button type="button" className="text-primary-600 dark:text-primary-400 underline mx-1" onClick={() => navigate('/dashboard')}>
            返回首页
          </button>
        </p>
      </main>

      <MobileBottomNav />

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId != null ? '编辑药品' : '新建药品'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="med-name">药品名称</label>
              <Input
                id="med-name"
                aria-label="药品名称"
                placeholder="例如：降压药"
                value={form.name}
                onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              />
              {fieldErrors.name && <p className="text-xs text-destructive mt-1">{fieldErrors.name}</p>}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-dosage">剂量说明</label>
                <Input
                  id="med-dosage"
                  aria-label="剂量说明"
                  placeholder="例如：5mg"
                  value={form.dosage}
                  onChange={(e) => setForm((prev) => ({ ...prev, dosage: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-form">剂型</label>
                <Select
                  id="med-form"
                  aria-label="剂型"
                  value={form.form}
                  onChange={(e) => setForm((prev) => ({ ...prev, form: e.target.value as MedicationForm }))}
                >
                  {MEDICATION_FORMS.map((option) => (
                    <option key={option} value={option}>{FORM_LABELS[option]}</option>
                  ))}
                </Select>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium mb-1 block" htmlFor="med-time">服药时刻（HH:mm，留空 = 按需 PRN）</label>
              <div className="flex items-center gap-2">
                <Input
                  id="med-time"
                  aria-label="服药时刻"
                  type="time"
                  value={timeDraft}
                  onChange={(e) => setTimeDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addTime();
                    }
                  }}
                />
                <Button type="button" variant="outline" className="min-h-11 shrink-0" onClick={addTime} aria-label="添加服药时刻">
                  <Plus className="w-4 h-4" aria-hidden />
                </Button>
              </div>
              {form.scheduleTimes.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {form.scheduleTimes.map((time) => (
                    <span
                      key={time}
                      data-testid={`form-time-${time}`}
                      className="inline-flex items-center gap-1 rounded-lg bg-primary/10 text-primary-700 dark:text-primary-300 px-2 py-1 text-[11px] font-semibold tabular-nums"
                    >
                      {time}
                      <button
                        type="button"
                        onClick={() => removeTime(time)}
                        aria-label={`移除时间 ${time}`}
                        className="rounded-full hover:bg-black/10 dark:hover:bg-white/10 p-0.5"
                      >
                        <X className="w-3 h-3" aria-hidden />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              {fieldErrors.scheduleTimes && <p className="text-xs text-destructive mt-1">{fieldErrors.scheduleTimes}</p>}
            </div>

            <fieldset>
              <legend className="text-sm font-medium mb-1">计划星期（留空 = 每天）</legend>
              <div className="flex flex-wrap gap-2">
                {SCHEDULE_OPTIONS.map((option) => {
                  const checked = form.scheduleDays.includes(option.value);
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label={option.label}
                      onClick={() => toggleScheduleDay(option.value)}
                      className={`min-h-11 px-3 rounded-xl text-sm font-semibold transition-colors alive-interactive motion-reduce:transition-none motion-reduce:duration-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 ${
                        checked
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-slate-200/80 dark:bg-white/10 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-start">开始日期</label>
                <Input
                  id="med-start"
                  aria-label="开始日期"
                  type="date"
                  value={form.startDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, startDate: e.target.value }))}
                />
                {fieldErrors.startDate && <p className="text-xs text-destructive mt-1">{fieldErrors.startDate}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-end">结束日期</label>
                <Input
                  id="med-end"
                  aria-label="结束日期"
                  type="date"
                  value={form.endDate}
                  onChange={(e) => setForm((prev) => ({ ...prev, endDate: e.target.value }))}
                />
                {fieldErrors.endDate && <p className="text-xs text-destructive mt-1">{fieldErrors.endDate}</p>}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-units">每次用量</label>
                <Input
                  id="med-units"
                  aria-label="每次用量"
                  type="number"
                  min="0.25"
                  step="0.25"
                  value={form.unitsPerDose}
                  onChange={(e) => setForm((prev) => ({ ...prev, unitsPerDose: e.target.value }))}
                />
                {fieldErrors.unitsPerDose && <p className="text-xs text-destructive mt-1">{fieldErrors.unitsPerDose}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-stock">库存数量</label>
                <Input
                  id="med-stock"
                  aria-label="库存数量"
                  type="number"
                  min="0"
                  value={form.stockQuantity}
                  onChange={(e) => setForm((prev) => ({ ...prev, stockQuantity: e.target.value }))}
                />
                {fieldErrors.stockQuantity && <p className="text-xs text-destructive mt-1">{fieldErrors.stockQuantity}</p>}
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-unit">库存单位</label>
                <Input
                  id="med-unit"
                  aria-label="库存单位"
                  placeholder="片 / 粒 / ml"
                  value={form.stockUnit}
                  onChange={(e) => setForm((prev) => ({ ...prev, stockUnit: e.target.value }))}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-refill">补货阈值</label>
                <Input
                  id="med-refill"
                  aria-label="补货阈值"
                  type="number"
                  min="0"
                  value={form.refillThreshold}
                  onChange={(e) => setForm((prev) => ({ ...prev, refillThreshold: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-prescriber">开药医师</label>
                <Input
                  id="med-prescriber"
                  aria-label="开药医师"
                  value={form.prescriber}
                  onChange={(e) => setForm((prev) => ({ ...prev, prescriber: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block" htmlFor="med-pharmacy">药房</label>
                <Input
                  id="med-pharmacy"
                  aria-label="药房"
                  value={form.pharmacy}
                  onChange={(e) => setForm((prev) => ({ ...prev, pharmacy: e.target.value }))}
                />
              </div>
            </div>

            <div className="flex items-center gap-3">
              <Switch
                id="med-active"
                aria-label="启用"
                checked={form.isActive}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isActive: checked }))}
              />
              <label className="text-sm" htmlFor="med-active">启用</label>
            </div>

            <div className="flex items-start gap-3">
              <Switch
                id="med-critical"
                data-testid="med-is-critical"
                aria-label="关键用药"
                checked={form.isCritical}
                onCheckedChange={(checked) => setForm((prev) => ({ ...prev, isCritical: checked }))}
              />
              <label className="text-sm" htmlFor="med-critical">
                关键用药
                <span className="block text-[11px] text-hint">可绕过免打扰时段，提醒不会被静音</span>
              </label>
            </div>

            {fieldErrors.form && <p className="text-sm text-destructive" role="alert">{fieldErrors.form}</p>}

            <Button
              className="w-full min-h-11 motion-reduce:transition-none motion-reduce:duration-0"
              onClick={() => void save()}
              disabled={saving}
              aria-label="保存药品"
            >
              {saving ? '保存中…' : '保存'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
