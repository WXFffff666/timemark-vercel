import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { createEgressGuard, type EgressGuard } from './egress-guard.service.js';

/**
 * Task 151: weather + air-quality enrichment.
 *
 * Source: Open-Meteo (https://open-meteo.com) - free, no API key required:
 *
 *   https://api.open-meteo.com/v1/forecast          forecast + current conditions
 *   https://air-quality-api.open-meteo.com/v1/air-quality   air quality (US AQI / PM)
 *
 * Both hosts are OUTBOUND egress and MUST be allowlisted. This service constructs its
 * egress guard with them as explicit extra hosts, so the allowlist holds by
 * construction; a deployment may also list them in EGRESS_ALLOWED_HOSTS.
 *
 * Caching: payloads live in `weather_cache` (shared across serverless instances) and
 * obey the repo's 5-minute Postgres/egress floor - a previous attempt, success OR
 * failure, younger than WEATHER_MIN_REFRESH_MS blocks a new upstream call. Forecast
 * payloads are fresh for 15 minutes; after a failed refresh the previous payload is
 * served marked `stale` instead of failing.
 *
 * Degradation: offline / unconfigured / upstream error NEVER throw to the route. The
 * caller gets `{ available: false, message: '天气不可用' }` (or a stale payload).
 */

const log = createLogger('weather');

export const WEATHER_PROVIDER_HOSTS = [
  'api.open-meteo.com',
  'air-quality-api.open-meteo.com',
] as const;

export const WEATHER_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
export const WEATHER_AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

export const WEATHER_UNAVAILABLE_MESSAGE = '天气不可用';
/** Forecast payload freshness window. */
export const WEATHER_FORECAST_TTL_MS = 15 * 60 * 1000;
/** Hard floor between two upstream attempts (the repo's 5-minute Postgres floor). */
export const WEATHER_MIN_REFRESH_MS = 5 * 60 * 1000;
export const WEATHER_FETCH_TIMEOUT_MS = 6_000;

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  label: string;
}

export interface WeatherCurrentView {
  temperatureC: number | null;
  apparentC: number | null;
  humidityPercent: number | null;
  windKph: number | null;
  precipitationMm: number | null;
  weatherCode: number | null;
  condition: string;
}

export interface WeatherDailyView {
  maxC: number | null;
  minC: number | null;
  precipitationProbability: number | null;
}

export interface WeatherAirQualityView {
  usAqi: number | null;
  pm25: number | null;
  pm10: number | null;
  level: string | null;
}

export interface TodayWeatherView {
  available: boolean;
  /** 天气不可用 when unavailable; null otherwise. */
  message: string | null;
  locationLabel: string | null;
  current: WeatherCurrentView | null;
  daily: WeatherDailyView | null;
  airQuality: WeatherAirQualityView | null;
  fetchedAt: string | null;
  stale: boolean;
}

export interface WeatherDeps {
  /** Clock in epoch ms; injectable for deterministic cache tests. */
  now?: () => number;
  /** fetch used by the default egress guard; injectable for tests / offline mode. */
  fetchImpl?: typeof fetch;
  /** Pre-built guard override; defaults to a guard that allowlists Open-Meteo. */
  guard?: Pick<EgressGuard, 'fetch'>;
  /** Location override; `undefined` reads `user_weather_settings`. */
  location?: WeatherLocation | null;
}

interface WeatherCacheRow {
  payload: unknown;
  fetchedAtMs: number;
  attemptedAtMs: number;
}

/** WMO 4677 weather-code -> Chinese description (Open-Meteo `weather_code`). */
const WEATHER_CODE_TEXT: Record<number, string> = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '雾',
  48: '雾凇',
  51: '毛毛雨',
  53: '毛毛雨',
  55: '毛毛雨',
  56: '冻毛毛雨',
  57: '冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '阵雪',
  86: '强阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '雷阵雨伴冰雹',
};

export function describeWeatherCode(code: number | null): string {
  if (code === null) return '未知';
  return WEATHER_CODE_TEXT[code] ?? '未知';
}

/** US AQI band -> Chinese level text. */
export function aqiLevel(usAqi: number): string {
  if (usAqi <= 50) return '优';
  if (usAqi <= 100) return '良';
  if (usAqi <= 150) return '轻度污染';
  if (usAqi <= 200) return '中度污染';
  if (usAqi <= 300) return '重度污染';
  return '严重污染';
}

function num(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The user's stored location, or null when unconfigured/disabled. */
export async function readWeatherLocation(userId: number): Promise<WeatherLocation | null> {
  const result = await query(
    `SELECT latitude, longitude, location_label FROM user_weather_settings WHERE user_id = $1 AND enabled = TRUE`,
    [userId],
  );
  const row = result.rows[0] as
    | { latitude?: unknown; longitude?: unknown; location_label?: unknown }
    | undefined;
  if (!row) return null;
  const latitude = num(row.latitude);
  const longitude = num(row.longitude);
  if (latitude === null || longitude === null) return null;
  return { latitude, longitude, label: String(row.location_label ?? '') };
}

/** Upsert the user's stored location (the weather key). */
export async function saveWeatherLocation(userId: number, location: WeatherLocation): Promise<void> {
  await query(
    `INSERT INTO user_weather_settings (user_id, latitude, longitude, location_label, enabled, updated_at)
     VALUES ($1, $2, $3, $4, TRUE, now())
     ON CONFLICT (user_id) DO UPDATE SET
       latitude = EXCLUDED.latitude,
       longitude = EXCLUDED.longitude,
       location_label = EXCLUDED.location_label,
       enabled = TRUE,
       updated_at = now()`,
    [userId, location.latitude, location.longitude, location.label],
  );
}

export function weatherCacheKey(location: WeatherLocation): string {
  return `open-meteo:${location.latitude.toFixed(3)},${location.longitude.toFixed(3)}`;
}

async function readWeatherCache(cacheKey: string): Promise<WeatherCacheRow | null> {
  const result = await query(
    `SELECT payload, fetched_at, attempted_at FROM weather_cache WHERE cache_key = $1`,
    [cacheKey],
  );
  const row = result.rows[0] as
    | { payload?: unknown; fetched_at?: unknown; attempted_at?: unknown }
    | undefined;
  if (!row) return null;
  return {
    payload: row.payload,
    fetchedAtMs: new Date(String(row.fetched_at)).getTime(),
    attemptedAtMs: new Date(String(row.attempted_at)).getTime(),
  };
}

/** Record a successful upstream fetch (payload + both clocks). */
async function writeWeatherCache(cacheKey: string, view: TodayWeatherView, atMs: number): Promise<void> {
  const at = new Date(atMs).toISOString();
  await query(
    `INSERT INTO weather_cache (cache_key, payload, fetched_at, attempted_at)
     VALUES ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)
     ON CONFLICT (cache_key) DO UPDATE SET
       payload = EXCLUDED.payload,
       fetched_at = EXCLUDED.fetched_at,
       attempted_at = EXCLUDED.attempted_at`,
    [cacheKey, JSON.stringify(view), at],
  );
}

/**
 * Record a failed attempt. On conflict only `attempted_at` moves, so the previous
 * payload stays servable (stale) and the 5-minute floor still applies.
 */
async function touchWeatherAttempt(cacheKey: string, atMs: number, fallback: TodayWeatherView): Promise<void> {
  const at = new Date(atMs).toISOString();
  await query(
    `INSERT INTO weather_cache (cache_key, payload, fetched_at, attempted_at)
     VALUES ($1, $2::jsonb, $3::timestamptz, $3::timestamptz)
     ON CONFLICT (cache_key) DO UPDATE SET attempted_at = EXCLUDED.attempted_at`,
    [cacheKey, JSON.stringify(fallback), at],
  );
}

function unavailableView(location: WeatherLocation | null): TodayWeatherView {
  return {
    available: false,
    message: WEATHER_UNAVAILABLE_MESSAGE,
    locationLabel: location?.label ?? null,
    current: null,
    daily: null,
    airQuality: null,
    fetchedAt: null,
    stale: false,
  };
}

function asCachedView(payload: unknown): TodayWeatherView | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<TodayWeatherView>;
  if (typeof candidate.available !== 'boolean') return null;
  return {
    available: candidate.available,
    message: candidate.available ? null : (candidate.message ?? WEATHER_UNAVAILABLE_MESSAGE),
    locationLabel: candidate.locationLabel ?? null,
    current: candidate.current ?? null,
    daily: candidate.daily ?? null,
    airQuality: candidate.airQuality ?? null,
    fetchedAt: candidate.fetchedAt ?? null,
    stale: false,
  };
}

/** Fetch + parse both Open-Meteo endpoints. Throws only when the FORECAST leg fails. */
async function fetchUpstream(
  location: WeatherLocation,
  deps: WeatherDeps,
  atMs: number,
): Promise<TodayWeatherView> {
  const guard =
    deps.guard ??
    createEgressGuard({
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      extraNotificationHosts: [...WEATHER_PROVIDER_HOSTS],
    });

  const forecastUrl = new URL(WEATHER_FORECAST_URL);
  forecastUrl.searchParams.set('latitude', String(location.latitude));
  forecastUrl.searchParams.set('longitude', String(location.longitude));
  forecastUrl.searchParams.set('timezone', 'auto');
  forecastUrl.searchParams.set('forecast_days', '1');
  forecastUrl.searchParams.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
  );
  forecastUrl.searchParams.set('daily', 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max');

  const airUrl = new URL(WEATHER_AIR_QUALITY_URL);
  airUrl.searchParams.set('latitude', String(location.latitude));
  airUrl.searchParams.set('longitude', String(location.longitude));
  airUrl.searchParams.set('timezone', 'auto');
  airUrl.searchParams.set('current', 'us_aqi,pm2_5,pm10');

  const signal = AbortSignal.timeout(WEATHER_FETCH_TIMEOUT_MS);
  const [forecastSettled, airSettled] = await Promise.allSettled([
    guard.fetch(forecastUrl.toString(), { signal, headers: { accept: 'application/json' } }),
    guard.fetch(airUrl.toString(), { signal, headers: { accept: 'application/json' } }),
  ]);

  if (forecastSettled.status === 'rejected') throw forecastSettled.reason;
  if (!forecastSettled.value.ok) {
    throw new Error(`open-meteo forecast HTTP ${forecastSettled.value.status}`);
  }
  const forecast = (await forecastSettled.value.json()) as Record<string, unknown>;
  const current = (forecast.current ?? {}) as Record<string, unknown>;
  const daily = (forecast.daily ?? {}) as Record<string, unknown>;
  const dailyFirst = (key: string): number | null => {
    const list = daily[key];
    return Array.isArray(list) && list.length > 0 ? num(list[0]) : null;
  };
  const weatherCode = num(current.weather_code);

  let airQuality: WeatherAirQualityView | null = null;
  if (airSettled.status === 'fulfilled' && airSettled.value.ok) {
    try {
      const air = (await airSettled.value.json()) as Record<string, unknown>;
      const airCurrent = (air.current ?? {}) as Record<string, unknown>;
      const usAqi = num(airCurrent.us_aqi);
      const pm25 = num(airCurrent.pm2_5);
      const pm10 = num(airCurrent.pm10);
      if (usAqi !== null || pm25 !== null || pm10 !== null) {
        airQuality = { usAqi, pm25, pm10, level: usAqi === null ? null : aqiLevel(usAqi) };
      }
    } catch (error) {
      log.warn({ event: 'weather.air_quality_parse_failed', err: error }, 'Air-quality payload unreadable; forecast still served');
    }
  } else if (airSettled.status === 'fulfilled') {
    log.warn(
      { event: 'weather.air_quality_http_error', status: airSettled.value.status },
      'Open-Meteo air quality returned a non-OK status; forecast still served',
    );
  } else {
    log.warn({ event: 'weather.air_quality_failed', err: airSettled.reason }, 'Open-Meteo air quality unreachable; forecast still served');
  }

  return {
    available: true,
    message: null,
    locationLabel: location.label,
    current: {
      temperatureC: num(current.temperature_2m),
      apparentC: num(current.apparent_temperature),
      humidityPercent: num(current.relative_humidity_2m),
      windKph: num(current.wind_speed_10m),
      precipitationMm: num(current.precipitation),
      weatherCode,
      condition: describeWeatherCode(weatherCode),
    },
    daily: {
      maxC: dailyFirst('temperature_2m_max'),
      minC: dailyFirst('temperature_2m_min'),
      precipitationProbability: dailyFirst('precipitation_probability_max'),
    },
    airQuality,
    fetchedAt: new Date(atMs).toISOString(),
    stale: false,
  };
}

/**
 * Today's weather for one user, keyed by the stored location.
 *
 * Never throws for offline / unconfigured / upstream failure: returns
 * `{ available: false, message: '天气不可用' }` or the previous (stale) payload.
 */
export async function getTodayWeather(userId: number, deps: WeatherDeps = {}): Promise<TodayWeatherView> {
  const nowMs = deps.now ? deps.now() : Date.now();

  let location: WeatherLocation | null;
  if (deps.location !== undefined) {
    location = deps.location;
  } else {
    try {
      location = await readWeatherLocation(userId);
    } catch (error) {
      log.warn({ event: 'weather.location_read_failed', err: error }, 'Weather location unreadable; degrading');
      location = null;
    }
  }
  if (!location) return unavailableView(null);

  const cacheKey = weatherCacheKey(location);
  let cached: WeatherCacheRow | null = null;
  try {
    cached = await readWeatherCache(cacheKey);
  } catch (error) {
    log.warn({ event: 'weather.cache_read_failed', err: error }, 'Weather cache unreadable; refreshing upstream');
  }

  let cachedView: TodayWeatherView | null = null;
  if (cached) {
    cachedView = asCachedView(cached.payload);
    if (cachedView) {
      const payloadFresh = cachedView.available
        ? nowMs - cached.fetchedAtMs < WEATHER_FORECAST_TTL_MS
        : nowMs - cached.fetchedAtMs < WEATHER_MIN_REFRESH_MS; // retry failures sooner
      if (payloadFresh) return cachedView;
      if (nowMs - cached.attemptedAtMs < WEATHER_MIN_REFRESH_MS) {
        // 5-minute floor: a recent attempt (even a failed one) blocks a new upstream call.
        return { ...cachedView, stale: cachedView.available };
      }
    }
  }

  try {
    const view = await fetchUpstream(location, deps, nowMs);
    try {
      await writeWeatherCache(cacheKey, view, nowMs);
    } catch (error) {
      log.warn({ event: 'weather.cache_write_failed', err: error }, 'Weather cache write failed; payload still served');
    }
    return view;
  } catch (error) {
    log.warn({ event: 'weather.refresh_failed', err: error }, 'Open-Meteo refresh failed; serving stale/unavailable');
    if (cachedView) {
      try {
        await touchWeatherAttempt(cacheKey, nowMs, cachedView);
      } catch (cacheError) {
        log.warn({ event: 'weather.cache_write_failed', err: cacheError }, 'Weather attempt marker write failed');
      }
      return { ...cachedView, stale: cachedView.available };
    }
    const marker = unavailableView(location);
    try {
      await touchWeatherAttempt(cacheKey, nowMs, marker);
    } catch (cacheError) {
      log.warn({ event: 'weather.cache_write_failed', err: cacheError }, 'Weather attempt marker write failed');
    }
    return marker;
  }
}
