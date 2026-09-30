import { Hono } from 'hono';
import { z } from 'zod';
import type { User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  getTodayWeather,
  readWeatherLocation,
  saveWeatherLocation,
  type WeatherLocation,
} from '../services/agent/weather.service.js';

/**
 * Task 151: weather + air-quality API, mounted at `/api/weather` (integrator).
 *
 *   GET /api/weather/today     today's forecast + air quality for the stored location
 *   GET /api/weather/settings  the stored location (or `configured: false`)
 *   PUT /api/weather/settings  store latitude/longitude/label
 *
 * `GET /today` always answers 200 with `{ available: false, message: '天气不可用' }`
 * when offline / unconfigured - the degradation is part of the contract, never a 5xx.
 */
const weather = new Hono<{ Variables: { user: User } }>();
weather.use('*', authMiddleware);

const settingsBodySchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  label: z.string().max(80).optional(),
});

weather.get('/today', async (c) => {
  const userId = Number(c.get('user').id);
  const view = await getTodayWeather(userId);
  return c.json({ success: true, data: view });
});

weather.get('/settings', async (c) => {
  const userId = Number(c.get('user').id);
  let location: WeatherLocation | null = null;
  try {
    location = await readWeatherLocation(userId);
  } catch {
    location = null;
  }
  return c.json({ success: true, data: { configured: location !== null, location } });
});

weather.put('/settings', async (c) => {
  const userId = Number(c.get('user').id);
  const raw: unknown = await c.req.json().catch(() => null);
  const parsed = settingsBodySchema.safeParse(raw);
  if (!parsed.success) {
    return c.json({ success: false, error: '请求参数无效' }, 400);
  }
  const { latitude, longitude } = parsed.data;
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180
  ) {
    return c.json({ success: false, error: '经纬度超出范围' }, 400);
  }
  const location: WeatherLocation = {
    latitude,
    longitude,
    label: (parsed.data.label ?? '').trim(),
  };
  await saveWeatherLocation(userId, location);
  return c.json({ success: true, data: { configured: true, location } });
});

export default weather;
