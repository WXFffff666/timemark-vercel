const MAX_TIME_DRIFT = 5 * 60 * 1000;
const SYNC_TTL_MS = 5 * 60 * 1000;

let cachedOffsetMs = 0;
let lastSyncAt = 0;
let lastSyncResult: TimeSyncResult | null = null;

export interface TimeSyncResult {
  success: boolean;
  currentTime: Date;
  serverTime?: Date;
  drift?: number;
  source: string;
  message: string;
}

function getCurrentTimestamp(): number {
  return Date.now();
}

async function fetchUtcMillisFromWorldTimeApi(): Promise<number | null> {
  try {
    const response = await fetch('https://worldtimeapi.org/api/timezone/Etc/UTC', {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { unixtime?: number; datetime?: string };
    if (typeof data.unixtime === 'number') return data.unixtime * 1000;
    if (data.datetime) return new Date(data.datetime).getTime();
    return null;
  } catch {
    return null;
  }
}

async function fetchUtcMillisFromTimeApiIo(): Promise<number | null> {
  try {
    const response = await fetch('https://timeapi.io/api/Time/current/zone?timeZone=UTC', {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const data = await response.json() as { dateTime?: string };
    return data.dateTime ? new Date(data.dateTime).getTime() : null;
  } catch {
    return null;
  }
}

async function queryAuthoritativeTime(): Promise<{ ts: number; source: string } | null> {
  const fetchers: Array<{ fn: () => Promise<number | null>; source: string }> = [
    { fn: fetchUtcMillisFromWorldTimeApi, source: 'worldtimeapi.org' },
    { fn: fetchUtcMillisFromTimeApiIo, source: 'timeapi.io' },
  ];

  const samples: Array<{ ts: number; source: string }> = [];
  for (const { fn, source } of fetchers) {
    const ts = await fn();
    if (ts) samples.push({ ts, source });
  }

  if (samples.length === 0) return null;

  samples.sort((a, b) => a.ts - b.ts);
  const median = samples[Math.floor(samples.length / 2)];
  return median;
}

export function getClockOffsetMs(): number {
  return cachedOffsetMs;
}

export function getSyncedNow(): Date {
  return new Date(Date.now() + cachedOffsetMs);
}

export async function getSyncedTimestamp(): Promise<number> {
  if (Date.now() - lastSyncAt > SYNC_TTL_MS) {
    await syncTime().catch(() => {});
  }
  return getSyncedNow().getTime();
}

export function getLastTimeSyncResult(): TimeSyncResult | null {
  return lastSyncResult;
}

export async function syncTime(): Promise<TimeSyncResult> {
  const currentTime = new Date();
  const currentTimestamp = getCurrentTimestamp();

  const authoritative = await queryAuthoritativeTime();
  if (!authoritative) {
    const result: TimeSyncResult = {
      success: true,
      currentTime,
      source: 'system',
      message: 'Using system time (network time sources unavailable)',
    };
    lastSyncResult = result;
    lastSyncAt = Date.now();
    return result;
  }

  const drift = authoritative.ts - currentTimestamp;
  cachedOffsetMs = drift;
  lastSyncAt = Date.now();

  const result: TimeSyncResult = {
    success: true,
    currentTime,
    serverTime: new Date(authoritative.ts),
    drift: Math.abs(drift),
    source: authoritative.source,
    message: Math.abs(drift) > MAX_TIME_DRIFT
      ? `Warning: Time drift of ${Math.round(Math.abs(drift) / 1000)}s detected`
      : 'Time synchronized successfully',
  };

  if (Math.abs(drift) > MAX_TIME_DRIFT) {
    console.warn(`[NTP] Time drift detected: ${drift}ms from ${authoritative.source}`);
  }

  lastSyncResult = result;
  return result;
}

export async function checkTimeSync(): Promise<void> {
  const result = await syncTime();
  console.log(`[NTP] Time sync result:`, result.message);
  if (result.drift && result.drift > MAX_TIME_DRIFT) {
    console.error(`[NTP] Significant time drift: ${result.drift}ms from ${result.source}`);
  }
}

export async function scheduledTimeSync(): Promise<void> {
  try {
    await checkTimeSync();
  } catch (error) {
    console.error('[NTP] Scheduled sync failed:', error);
  }
}

/** 记录显著时间漂移（仅日志，不阻断提醒） */
export async function logTimeDriftIfNeeded(): Promise<void> {
  const result = lastSyncResult ?? await syncTime();
  if (!result.drift || result.drift <= MAX_TIME_DRIFT) return;
  console.warn(`[NTP] Significant drift ${result.drift}ms from ${result.source}`);
}
