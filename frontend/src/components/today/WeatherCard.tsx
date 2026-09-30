import { useState } from 'react';
import { CloudSun, MapPin, Settings2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { CardShell } from './CardShell';
import { useCardData } from './useCardData';

/**
 * 天气卡片 (task 151)。遵循 Today 卡片契约（CardShell + useCardData），每张卡片独立加载。
 *
 * 消费 `GET /api/weather/today` 与 `GET/PUT /api/weather/settings`；后端离线 / 未配置 /
 * 上游失败时返回 `{ available: false, message: '天气不可用' }`，卡片原样展示该消息并
 * 提供「设置位置」表单——不抛错、不留空骨架屏。
 *
 * integrator：在 cards.ts 注册 'weather' 卡片并在 Today.tsx 的 TodayCard switch 中渲染。
 */

interface WeatherToday {
  available: boolean;
  message: string | null;
  locationLabel: string | null;
  current: {
    temperatureC: number | null;
    apparentC: number | null;
    humidityPercent: number | null;
    windKph: number | null;
    precipitationMm: number | null;
    weatherCode: number | null;
    condition: string;
  } | null;
  daily: {
    maxC: number | null;
    minC: number | null;
    precipitationProbability: number | null;
  } | null;
  airQuality: {
    usAqi: number | null;
    pm25: number | null;
    pm10: number | null;
    level: string | null;
  } | null;
  fetchedAt: string | null;
  stale: boolean;
}

interface WeatherSettings {
  configured: boolean;
  location: { latitude: number; longitude: number; label: string } | null;
}

function fmt(value: number | null, digits = 0): string {
  return value === null ? '--' : value.toFixed(digits);
}

export function WeatherCard() {
  const { data: view, loading, error, reload } = useCardData(
    () => api.get<WeatherToday>('/weather/today'),
    [],
  );
  const [showForm, setShowForm] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [label, setLabel] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const toggleForm = () => {
    const next = !showForm;
    setShowForm(next);
    if (next && !settingsLoaded) {
      setSettingsLoaded(true);
      void api
        .get<WeatherSettings>('/weather/settings')
        .then((settings) => {
          if (!settings.location) return;
          setLatitude(String(settings.location.latitude));
          setLongitude(String(settings.location.longitude));
          setLabel(settings.location.label);
        })
        .catch(() => {
          // 预填失败不阻塞表单：留空让用户重新输入。
        });
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const lat = Number(latitude);
    const lon = Number(longitude);
    if (
      !Number.isFinite(lat) ||
      lat < -90 ||
      lat > 90 ||
      !Number.isFinite(lon) ||
      lon < -180 ||
      lon > 180
    ) {
      setFormError('请输入有效经纬度（纬度 -90~90，经度 -180~180）');
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await api.put('/weather/settings', { latitude: lat, longitude: lon, label: label.trim() });
      setShowForm(false);
      reload();
    } catch (reason) {
      setFormError(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const current = view?.current ?? null;
  const daily = view?.daily ?? null;
  const air = view?.airQuality ?? null;
  const unavailable = view !== null && !view.available;

  return (
    <CardShell
      title="天气"
      icon={<CloudSun size={16} aria-hidden />}
      loading={loading}
      error={error}
      onRetry={reload}
    >
      <div data-testid="weather-card">
        {unavailable ? (
          <p className="text-sm text-hint" data-testid="weather-unavailable">
            {view?.message ?? '天气不可用'}
          </p>
        ) : current ? (
          <div>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-bold text-slate-800 dark:text-slate-100">
                {fmt(current.temperatureC)}°
              </span>
              <span className="text-sm text-slate-600 dark:text-slate-300">{current.condition}</span>
              {view?.stale ? <span className="text-[10px] text-amber-500">缓存数据</span> : null}
            </div>
            <p className="mt-1 text-xs text-hint">
              {daily ? `最高 ${fmt(daily.maxC)}° / 最低 ${fmt(daily.minC)}°` : ''}
              {daily && daily.precipitationProbability !== null
                ? ` · 降水概率 ${fmt(daily.precipitationProbability)}%`
                : ''}
            </p>
            <p className="mt-1 text-xs text-hint">
              体感 {fmt(current.apparentC)}° · 湿度 {fmt(current.humidityPercent)}% · 风速{' '}
              {fmt(current.windKph)} km/h
            </p>
            {air && (air.usAqi !== null || air.pm25 !== null) ? (
              <p className="mt-1 text-xs text-hint">
                空气 {air.level ?? '--'}
                {air.usAqi !== null ? ` · US AQI ${air.usAqi}` : ''}
                {air.pm25 !== null ? ` · PM2.5 ${fmt(air.pm25, 1)}` : ''}
              </p>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-hint">暂无数据</p>
        )}

        <div className="mt-3 flex items-center gap-2">
          <Button variant="ghost" size="sm" className="rounded-full" onClick={toggleForm} data-testid="weather-settings-toggle">
            <Settings2 size={14} aria-hidden /> 设置位置
          </Button>
          {view?.locationLabel ? (
            <span className="inline-flex items-center gap-1 text-[11px] text-hint">
              <MapPin size={12} aria-hidden />
              {view.locationLabel}
            </span>
          ) : null}
        </div>

        {showForm ? (
          <form onSubmit={submit} className="mt-3 space-y-2" data-testid="weather-settings-form">
            <div className="flex gap-2">
              <input
                type="number"
                step="0.0001"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="纬度"
                aria-label="纬度"
                className="w-1/2 rounded-lg border border-slate-200 bg-white/70 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
              />
              <input
                type="number"
                step="0.0001"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="经度"
                aria-label="经度"
                className="w-1/2 rounded-lg border border-slate-200 bg-white/70 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
              />
            </div>
            <input
              type="text"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="地点名称（可选）"
              aria-label="地点名称"
              maxLength={80}
              className="w-full rounded-lg border border-slate-200 bg-white/70 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-900/60"
            />
            {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
            <Button type="submit" size="sm" disabled={saving} data-testid="weather-settings-save">
              {saving ? '保存中…' : '保存'}
            </Button>
          </form>
        ) : null}
      </div>
    </CardShell>
  );
}

export default WeatherCard;
