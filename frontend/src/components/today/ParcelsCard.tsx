import { useState } from 'react';
import { Package, Plus } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';

/**
 * 包裹卡片 (task 152)。遵循 Today 卡片契约（CardShell + useCardData），每张卡片独立加载。
 *
 * 消费 `GET /api/parcels`、`GET /api/parcels/reminders`、`POST /api/parcels` 与
 * `PATCH /api/parcels/:id`；提醒条显示「派送中 / 物流停滞」。
 *
 * 隐私：UI 只展示后端返回的 `trackingNumberMasked`（如 `****1234`），绝不渲染完整单号；
 * 后端日志同样只写掩码形式。
 *
 * integrator：在 cards.ts 注册 'parcels' 卡片并在 Today.tsx 的 TodayCard switch 中渲染。
 */

type ParcelStatus = 'registered' | 'in_transit' | 'out_for_delivery' | 'delivered' | 'exception';

interface Parcel {
  id: number;
  carrier: string;
  trackingNumber: string;
  trackingNumberMasked: string;
  label: string;
  status: ParcelStatus;
  lastEvent: string | null;
  lastEventAt: string | null;
  eta: string | null;
}

interface ParcelReminder {
  parcelId: number;
  kind: 'out_for_delivery' | 'stalled';
  title: string;
  detail: string;
  trackingNumberMasked: string;
}

interface ParcelsData {
  parcels: Parcel[];
  reminders: ParcelReminder[];
}

const STATUS_TEXT: Record<ParcelStatus, string> = {
  registered: '已登记',
  in_transit: '运输中',
  out_for_delivery: '派送中',
  delivered: '已签收',
  exception: '异常',
};

const STATUS_CLASS: Record<ParcelStatus, string> = {
  registered: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  in_transit: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  out_for_delivery: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  delivered: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300',
  exception: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
};

export function ParcelsCard() {
  const { data, loading, error, reload } = useCardData<ParcelsData>(async () => {
    const [parcelsResult, remindersResult] = await Promise.all([
      api.get<{ parcels: Parcel[] }>('/parcels'),
      api
        .get<{ reminders: ParcelReminder[] }>('/parcels/reminders')
        .catch(() => ({ reminders: [] as ParcelReminder[] })),
    ]);
    return {
      parcels: Array.isArray(parcelsResult?.parcels) ? parcelsResult.parcels : [],
      reminders: Array.isArray(remindersResult?.reminders) ? remindersResult.reminders : [],
    };
  }, []);

  const [showForm, setShowForm] = useState(false);
  const [carrier, setCarrier] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (carrier.trim() === '' || trackingNumber.trim() === '') {
      setFormError('请填写快递公司与单号');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/parcels', {
        carrier: carrier.trim(),
        trackingNumber: trackingNumber.trim(),
        label: label.trim(),
      });
      setCarrier('');
      setTrackingNumber('');
      setLabel('');
      setShowForm(false);
      reload();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const markStatus = async (id: number, status: ParcelStatus) => {
    setBusyId(id);
    try {
      await api.patch(`/parcels/${id}`, { status });
      reload();
    } catch {
      // 手动更新失败时保持列表原样，等待下一次刷新。
    } finally {
      setBusyId(null);
    }
  };

  const parcels = data?.parcels ?? [];
  const reminders = data?.reminders ?? [];

  return (
    <CardShell title="包裹" icon={<Package size={16} aria-hidden />} loading={loading} error={error} onRetry={reload}>
      <div data-testid="parcels-card">
        {reminders.length > 0 ? (
          <p className="mb-2 text-xs text-amber-600 dark:text-amber-400" data-testid="parcels-reminders">
            {reminders.map((reminder) => `${reminder.title} · ${reminder.detail}`).join('；')}
          </p>
        ) : null}

        {parcels.length === 0 ? (
          <p className="text-sm text-hint">暂无包裹</p>
        ) : (
          <ul className="space-y-2">
            {parcels.map((parcel) => (
              <li
                key={parcel.id}
                data-testid={`parcel-${parcel.id}`}
                className="rounded-xl bg-white/50 px-3 py-2 dark:bg-white/5"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800 dark:text-slate-100">
                      {parcel.label.trim() === '' ? parcel.carrier : parcel.label}
                    </p>
                    <p className="text-xs text-hint">
                      {parcel.carrier} · {parcel.trackingNumberMasked}
                      {parcel.eta ? ` · 预计 ${parcel.eta}` : ''}
                    </p>
                    {parcel.lastEvent ? (
                      <p className="truncate text-[11px] text-hint" title={parcel.lastEvent}>
                        {parcel.lastEvent}
                      </p>
                    ) : null}
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STATUS_CLASS[parcel.status]}`}
                  >
                    {STATUS_TEXT[parcel.status]}
                  </span>
                </div>
                {parcel.status !== 'delivered' ? (
                  <div className="mt-1 flex gap-3">
                    {parcel.status !== 'out_for_delivery' ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1 text-[11px] text-amber-600"
                        disabled={busyId === parcel.id}
                        onClick={() => void markStatus(parcel.id, 'out_for_delivery')}
                      >
                        派送中
                      </Button>
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1 text-[11px] text-emerald-600"
                      disabled={busyId === parcel.id}
                      onClick={() => void markStatus(parcel.id, 'delivered')}
                    >
                      已签收
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3">
          <Button
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => setShowForm((open) => !open)}
            data-testid="parcels-add-toggle"
          >
            <Plus size={14} aria-hidden /> 添加包裹
          </Button>
        </div>

        {showForm ? (
          <form onSubmit={submit} className="mt-2 space-y-2" data-testid="parcels-add-form">
            <input
              type="text"
              value={carrier}
              onChange={(event) => setCarrier(event.target.value)}
              placeholder="快递公司（如 SF）"
              aria-label="快递公司"
              maxLength={64}
              className="w-full rounded-lg border border-slate-200 bg-white/70 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
            />
            <input
              type="text"
              value={trackingNumber}
              onChange={(event) => setTrackingNumber(event.target.value)}
              placeholder="快递单号"
              aria-label="快递单号"
              maxLength={128}
              className="w-full rounded-lg border border-slate-200 bg-white/70 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
            />
            <input
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="备注名（可选）"
              aria-label="备注名"
              maxLength={80}
              className="w-full rounded-lg border border-slate-200 bg-white/70 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
            />
            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
            <Button type="submit" size="sm" disabled={saving} data-testid="parcels-add-save">
              {saving ? '添加中…' : '添加'}
            </Button>
          </form>
        ) : null}
      </div>
    </CardShell>
  );
}

export default ParcelsCard;
