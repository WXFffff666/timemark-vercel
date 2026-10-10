import { Hono } from 'hono';
import { normalizeTimezone } from '../utils/timezone.js';
import {
  DEFAULT_SYNC_TIMEZONE,
  formatLocalHHmm,
  formatTodayYmd,
  getClockOffsetMs,
  getLastTimeSyncResult,
  getSyncedNow,
  scheduleTimeSync,
  syncTime,
} from '../utils/ntp.js';
import { runLunarCalendarSelfTest } from '@timemark/shared/lunar-calendar';
import { lunarConverter } from '../utils/lunar-converter.js';

const timeRoutes = new Hono();

// v2.31 R1（安全审计 S5）：?refresh=1 可被匿名滥用为强制出站 NTP 同步的放大器，
// 农历自检也是每请求纯计算。两者加 60s 进程内节流（时间查询本身仍走缓存即时返回）。
let lastForceSyncAt = 0;
let lastSelfTestAt = 0;
let cachedSelfTest: ReturnType<typeof runLunarCalendarSelfTest> | null = null;

/** 公开：时间/NTP/双历自检（不阻塞，默认读缓存） */
timeRoutes.get('/status', async (c) => {
  const requestedTz = normalizeTimezone(c.req.query('timezone') || DEFAULT_SYNC_TIMEZONE);
  const force = c.req.query('refresh') === '1' && Date.now() - lastForceSyncAt > 60_000;
  if (force) lastForceSyncAt = Date.now();

  let sync;
  if (force) {
    sync = await syncTime(requestedTz, { force: true });
  } else {
    const cached = getLastTimeSyncResult(requestedTz);
    if (cached) {
      sync = cached;
      scheduleTimeSync(requestedTz);
    } else {
      scheduleTimeSync(requestedTz);
      const now = new Date();
      sync = {
        success: true,
        timeZone: requestedTz,
        currentTime: now,
        serverTime: now,
        todayYmd: formatTodayYmd(now, requestedTz),
        localTimeHHmm: formatLocalHHmm(now, requestedTz),
        source: 'system',
        message: 'Using system time (background NTP sync started)',
      };
    }
  }

  // 农历自检结果缓存 60s（纯计算，公网匿名面不值得每请求全跑）
  if (!cachedSelfTest || Date.now() - lastSelfTestAt > 60_000) {
    cachedSelfTest = runLunarCalendarSelfTest(lunarConverter);
    lastSelfTestAt = Date.now();
  }
  const calendarVerify = cachedSelfTest;
  const now = getSyncedNow(requestedTz);

  return c.json({
    success: true,
    data: {
      timeZone: sync.timeZone,
      serverNow: now.toISOString(),
      todayYmd: sync.todayYmd,
      localTimeHHmm: sync.localTimeHHmm,
      clockOffsetMs: getClockOffsetMs(requestedTz),
      driftMs: sync.drift ?? 0,
      source: sync.source,
      message: sync.message,
      calendarVerify,
    },
  });
});

export default timeRoutes;
