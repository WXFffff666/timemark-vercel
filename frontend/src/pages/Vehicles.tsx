import { useCallback, useEffect, useState } from 'react';
import { Car, Fuel, Loader2, Plus, Trash2, Wrench } from 'lucide-react';
import { api } from '@/lib/api';
import { PageHeader } from '@/components/layout/PageHeader';
import { EmptyState } from '@/components/ui/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SkeletonCard } from '@/components/ui/skeleton-card';

/**
 * v2.31 v2.32 R8（审计 D3）：车辆管理页——vehicles 路由（含加油账本 + 保养记录）
 * 此前只有 API 没有任何前端入口。表单尽量最小：加车/记加油/记保养。
 */

interface Vehicle {
  id: number;
  make: string;
  model: string;
  year: number | null;
  plate: string;
  odometer: number;
}

interface FuelRecord {
  id: number;
  date: string;
  energyType: 'fuel' | 'electric';
  unit: 'L' | 'kWh';
  quantity: number;
  totalCost: number;
  odometer: number;
  distanceKm: number | null;
  consumptionPer100: number | null;
  costPerKm: number | null;
}

interface MaintenanceRecord {
  id: number;
  item: string;
  date: string;
  cost: number | null;
  nextDueDate: string | null;
  nextDueOdometer: number | null;
}

interface Ledger {
  records?: FuelRecord[];
  summary?: { recordCount: number; totalQuantity: number; totalCost: number; averageConsumptionPer100: number | null; averageCostPerKm: number | null };
  maintenance?: MaintenanceRecord[];
}

const today = () => new Date().toISOString().slice(0, 10);

export default function Vehicles() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [ledgers, setLedgers] = useState<Record<number, Ledger | null>>({});

  // 加车表单
  const [showAdd, setShowAdd] = useState(false);
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [plate, setPlate] = useState('');
  const [adding, setAdding] = useState(false);

  // 加油表单（按车）
  const [fuelFor, setFuelFor] = useState<number | null>(null);
  const [fuelDate, setFuelDate] = useState(today());
  const [fuelQty, setFuelQty] = useState('');
  const [fuelCost, setFuelCost] = useState('');
  const [fuelOdo, setFuelOdo] = useState('');
  // v2.35 R19（审计 #3）：能源类型此前不发，电动车充电被记成"升"且油耗口径错误
  const [energyType, setEnergyType] = useState<'fuel' | 'electric'>('fuel');

  // 保养表单（按车）
  const [maintFor, setMaintFor] = useState<number | null>(null);
  const [maintItem, setMaintItem] = useState('');
  const [maintDate, setMaintDate] = useState(today());
  // v2.34 R15（审计 #1）：花费/下次到期——/vehicles/reminders 完全依赖这些字段
  const [maintCost, setMaintCost] = useState('');
  const [maintNextDate, setMaintNextDate] = useState('');
  // v2.34 R15（审计 #1）：到期提醒横幅
  const [dueReminders, setDueReminders] = useState<Array<{ vehicleId: number; vehicleLabel: string; maintenanceId: number; item: string; nextDueDate: string | null; nextDueOdometer: number | null }>>([]);

  const load = useCallback(() => {
    setLoading(true);
    api
      .get<{ vehicles: Vehicle[] }>('/vehicles')
      .then((d) => setVehicles(d.vehicles ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false));
    // v2.34 R15（审计 #1）：到期提醒（保养 next_due 字段驱动）
    api
      .get<{ reminders: Array<{ vehicleId: number; make: string; model: string; maintenanceId: number; item: string; nextDueDate: string | null; nextDueOdometer: number | null }> }>('/vehicles/reminders')
      .then((d) => {
        setDueReminders((d.reminders ?? []).map((r) => ({
          vehicleId: r.vehicleId,
          vehicleLabel: [r.make, r.model].filter(Boolean).join(' '),
          maintenanceId: r.maintenanceId,
          item: r.item,
          nextDueDate: r.nextDueDate,
          nextDueOdometer: r.nextDueOdometer,
        })));
      })
      .catch(() => setDueReminders([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadLedger = useCallback(async (id: number) => {
    setLedgers((prev) => ({ ...prev, [id]: null }));
    try {
      const [fuel, maint] = await Promise.all([
        api.get<Ledger>(`/vehicles/${id}/fuel`),
        api.get<Ledger>(`/vehicles/${id}/maintenance`),
      ]);
      setLedgers((prev) => ({ ...prev, [id]: { records: fuel.records, summary: fuel.summary, maintenance: maint.maintenance } }));
    } catch {
      setLedgers((prev) => ({ ...prev, [id]: {} }));
    }
  }, []);

  const toggleLedger = (id: number) => {
    if (ledgers[id] === undefined) void loadLedger(id);
    else setLedgers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const addVehicle = async () => {
    if (!make.trim()) {
      setError('请填写品牌');
      return;
    }
    setAdding(true);
    setError('');
    try {
      await api.post('/vehicles', { make: make.trim(), model: model.trim() || undefined, plate: plate.trim() || undefined });
      setMake('');
      setModel('');
      setPlate('');
      setShowAdd(false);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '添加失败');
    } finally {
      setAdding(false);
    }
  };

  const removeVehicle = async (id: number) => {
    if (!confirm('删除车辆会一并删除其加油/保养记录，确定？')) return;
    try {
      await api.delete(`/vehicles/${id}`);
      setVehicles((prev) => prev.filter((v) => v.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  // v2.34 R15（审计 #9）：录错的记录可删，否则油耗/成本统计被永久污染
  const deleteFuelRecord = async (vehicleId: number, recordId: number) => {
    if (!confirm('删除这条加油/充电记录？')) return;
    try {
      await api.delete(`/vehicles/${vehicleId}/fuel/${recordId}`);
      void loadLedger(vehicleId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const deleteMaintenanceRecord = async (vehicleId: number, recordId: number) => {
    if (!confirm('删除这条保养记录？')) return;
    try {
      await api.delete(`/vehicles/${vehicleId}/maintenance/${recordId}`);
      void loadLedger(vehicleId);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  const addFuel = async (id: number) => {
    const qty = Number(fuelQty);
    const odo = Number(fuelOdo);
    if (!fuelQty || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(odo) || odo < 0) {
      setError('加油量与里程表读数必填（须为有效数字）');
      return;
    }
    setError('');
    try {
      await api.post(`/vehicles/${id}/fuel`, {
        date: fuelDate,
        energyType,
        quantity: qty,
        odometer: odo,
        totalCost: fuelCost ? Number(fuelCost) : undefined,
      });
      setFuelQty('');
      setFuelCost('');
      void loadLedger(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败');
    }
  };

  const addMaintenance = async (id: number) => {
    if (!maintItem.trim()) {
      setError('请填写保养项目');
      return;
    }
    setError('');
    try {
      await api.post(`/vehicles/${id}/maintenance`, {
        item: maintItem.trim(),
        date: maintDate,
        cost: maintCost ? Number(maintCost) : undefined,
        nextDueDate: maintNextDate || undefined,
      });
      setMaintItem('');
      setMaintCost('');
      setMaintNextDate('');
      void loadLedger(id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '记录失败');
    }
  };

  return (
    <div className="min-h-screen pb-24">
      <PageHeader
        title="车辆"
        subtitle="加油账本 · 保养记录 · 里程统计"
        back="smart"
        onRefresh={load}
        refreshing={loading}
      />

      {/* v2.34 R15（审计 #1）：保养到期提醒横幅 */}
      {dueReminders.length > 0 && (
        <div role="status" className="max-w-3xl mx-auto px-6 mt-4 rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50/60 dark:bg-amber-900/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300 space-y-1">
          {dueReminders.map((r) => (
            <p key={r.maintenanceId}>
              🔧 {r.vehicleLabel} · {r.item}
              {r.nextDueDate ? ` — 到期 ${r.nextDueDate}` : ''}
              {r.nextDueOdometer !== null ? `（里程 ${r.nextDueOdometer.toLocaleString()} km）` : ''}
            </p>
          ))}
        </div>
      )}

      <main className="max-w-3xl mx-auto px-6 py-6 space-y-5">
        {error && (
          <p role="alert" className="rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50/60 dark:bg-red-900/10 px-4 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="flex justify-end">
          <Button onClick={() => setShowAdd((v) => !v)} aria-label="添加车辆">
            {showAdd ? null : <Plus className="w-4 h-4 mr-1" aria-hidden />}
            {showAdd ? '收起' : '添加车辆'}
          </Button>
        </div>

        {showAdd && (
          <div className="glass-panel rounded-3xl p-4 flex flex-wrap gap-2 items-end">
            <Input value={make} onChange={(e) => setMake(e.target.value)} placeholder="品牌（必填）" aria-label="品牌" className="w-32" />
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="型号" aria-label="型号" className="w-36" />
            <Input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="车牌（可选）" aria-label="车牌" className="w-32" />
            <Button onClick={() => void addVehicle()} disabled={adding} aria-label="保存车辆">
              {adding ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden /> : null}
              保存
            </Button>
          </div>
        )}

        {loading ? (
          <SkeletonCard count={3} />
        ) : vehicles.length === 0 ? (
          <EmptyState icon={Car} title="还没有添加车辆" description="添加车辆后可记录加油与保养，自动算油耗/每公里成本" />
        ) : (
          <ul className="space-y-4">
            {vehicles.map((v) => {
              const ledger = ledgers[v.id];
              return (
                <li key={v.id} className="glass-panel rounded-3xl p-5 space-y-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary-50 text-primary-600 dark:bg-primary-900/40 dark:text-primary-300 shrink-0" aria-hidden>
                        <Car size={22} />
                      </span>
                      <div className="min-w-0">
                        <h2 className="font-bold text-slate-900 dark:text-white truncate">
                          {v.make} {v.model}
                          {v.year ? <span className="text-sm text-slate-400 font-normal"> · {v.year}</span> : null}
                        </h2>
                        <p className="text-xs text-slate-400">
                          {v.plate ? <Badge variant="outline" className="mr-2 scale-90">{v.plate}</Badge> : null}
                          里程表 {v.odometer.toLocaleString()} km
                        </p>
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <Button size="sm" variant="outline" className="rounded-full" onClick={() => toggleLedger(v.id)} aria-expanded={!!ledgers[v.id]}>
                        <Fuel size={14} className="mr-1" aria-hidden /> 账本
                      </Button>
                      <Button size="icon" variant="ghost" className="min-h-9 min-w-9 text-red-500" aria-label={`删除 ${v.make} ${v.model}`} onClick={() => void removeVehicle(v.id)}>
                        <Trash2 size={15} aria-hidden />
                      </Button>
                    </div>
                  </div>

                  {ledger && (
                    <div className="space-y-4 border-t border-slate-200/60 dark:border-slate-700/50 pt-4">
                      {/* 加油汇总 + 新增 */}
                      {ledger.summary && ledger.summary.recordCount > 0 && (
                        <p className="text-xs text-slate-500 dark:text-slate-400">
                          共 {ledger.summary.recordCount} 次 · 总花费 ¥{ledger.summary.totalCost.toFixed(2)}
                          {ledger.summary.averageConsumptionPer100 !== null ? ` · 平均 ${ledger.summary.averageConsumptionPer100.toFixed(1)} ${ledger.records?.[0]?.unit ?? 'L'}/100km` : ''}
                          {ledger.summary.averageCostPerKm !== null ? ` · ¥${ledger.summary.averageCostPerKm.toFixed(2)}/km` : ''}
                        </p>
                      )}
                      {fuelFor === v.id ? (
                        <div className="flex flex-wrap gap-2 items-end">
                          <Input type="date" value={fuelDate} onChange={(e) => setFuelDate(e.target.value)} aria-label="加油日期" className="w-36" />
                          <select value={energyType} onChange={(e) => setEnergyType(e.target.value as 'fuel' | 'electric')} aria-label="能源类型" className="h-10 px-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 text-sm text-slate-900 dark:text-white">
                            <option value="fuel">加油（升）</option>
                            <option value="electric">充电（kWh）</option>
                          </select>
                          <Input value={fuelQty} onChange={(e) => setFuelQty(e.target.value)} placeholder="升/kWh 数" aria-label="加油量" inputMode="decimal" className="w-24" />
                          <Input value={fuelCost} onChange={(e) => setFuelCost(e.target.value)} placeholder="花费 ¥（可选）" aria-label="花费" inputMode="decimal" className="w-28" />
                          <Input value={fuelOdo} onChange={(e) => setFuelOdo(e.target.value)} placeholder="里程表读数" aria-label="里程表读数" inputMode="numeric" className="w-32" />
                          <Button size="sm" onClick={() => void addFuel(v.id)} aria-label="保存加油记录">保存</Button>
                          <Button size="sm" variant="ghost" onClick={() => setFuelFor(null)} aria-label="取消加油记录">取消</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="rounded-full" onClick={() => { setFuelFor(v.id); setMaintFor(null); }}>
                          <Fuel size={14} className="mr-1" aria-hidden /> 记一笔加油/充电
                        </Button>
                      )}

                      {ledger.records && ledger.records.length > 0 && (
                        <ul className="space-y-1 text-xs" aria-label="加油记录">
                          {[...ledger.records].reverse().slice(0, 5).map((r) => (
                            <li key={r.id} className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-1.5">
                              <span className="tabular-nums text-slate-500 shrink-0">{r.date}</span>
                              <span className="tabular-nums">{r.quantity} {r.unit}</span>
                              <span className="tabular-nums text-slate-500">¥{r.totalCost.toFixed(2)}</span>
                              {r.consumptionPer100 !== null && <span className="tabular-nums text-emerald-600 dark:text-emerald-400 ml-auto">{r.consumptionPer100.toFixed(1)} {r.unit}/100km</span>}
                              <Button size="icon" variant="ghost" className="min-h-7 min-w-7 text-red-400 hover:text-red-500 shrink-0" aria-label={`删除 ${r.date} 的加油记录`} onClick={() => void deleteFuelRecord(v.id, r.id)}>
                                <Trash2 size={13} aria-hidden />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}

                      {/* 保养 */}
                      {maintFor === v.id ? (
                        <div className="flex flex-wrap gap-2 items-end">
                          <Input value={maintItem} onChange={(e) => setMaintItem(e.target.value)} placeholder="保养项目（如 更换机油）" aria-label="保养项目" className="flex-1 min-w-[10rem]" />
                          <Input type="date" value={maintDate} onChange={(e) => setMaintDate(e.target.value)} aria-label="保养日期" className="w-36" />
                          <Input value={maintCost} onChange={(e) => setMaintCost(e.target.value)} placeholder="花费 ¥（可选）" aria-label="保养花费" inputMode="decimal" className="w-28" />
                          <Input type="date" value={maintNextDate} onChange={(e) => setMaintNextDate(e.target.value)} aria-label="下次到期日期（可选）" className="w-36" />
                          <Button size="sm" onClick={() => void addMaintenance(v.id)} aria-label="保存保养记录">保存</Button>
                          <Button size="sm" variant="ghost" onClick={() => setMaintFor(null)} aria-label="取消保养记录">取消</Button>
                        </div>
                      ) : (
                        <Button size="sm" variant="outline" className="rounded-full" onClick={() => { setMaintFor(v.id); setFuelFor(null); }}>
                          <Wrench size={14} className="mr-1" aria-hidden /> 记一笔保养
                        </Button>
                      )}
                      {ledger.maintenance && ledger.maintenance.length > 0 && (
                        <ul className="space-y-1 text-xs" aria-label="保养记录">
                          {[...ledger.maintenance].reverse().slice(0, 5).map((m) => (
                            <li key={m.id} className="flex items-center gap-2 rounded-lg bg-slate-50 dark:bg-slate-800/60 px-3 py-1.5">
                              <Wrench size={12} className="text-orange-500 shrink-0" aria-hidden />
                              <span className="truncate">{m.item}</span>
                              <span className="tabular-nums text-slate-500 ml-auto shrink-0">{m.date}</span>
                              {m.nextDueDate && <span className="text-amber-500 shrink-0">下次 {m.nextDueDate}</span>}
                              <Button size="icon" variant="ghost" className="min-h-7 min-w-7 text-red-400 hover:text-red-500 shrink-0" aria-label={`删除「${m.item}」保养记录`} onClick={() => void deleteMaintenanceRecord(v.id, m.id)}>
                                <Trash2 size={13} aria-hidden />
                              </Button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
