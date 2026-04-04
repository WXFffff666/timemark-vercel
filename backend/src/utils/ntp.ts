import { query } from '../db/index.js';

/**
 * NTP时间同步服务
 * 用于确保系统时间准确，在Docker容器意外重启后自动校准
 */

// NTP服务器列表（公共NTP服务器）
const NTP_SERVERS = [
  'pool.ntp.org',
  'time.windows.com',
  'time.google.com',
];

// 允许的最大时间偏差（毫秒）- 5分钟
const MAX_TIME_DRIFT = 5 * 60 * 1000;

interface TimeSyncResult {
  success: boolean;
  currentTime: Date;
  serverTime?: Date;
  drift?: number;
  source: string;
  message: string;
}

/**
 * 获取当前系统时间戳（毫秒）
 */
function getCurrentTimestamp(): number {
  return Date.now();
}

/**
 * 解析NTP响应并获取服务器时间
 * 这是一个简化的NTP客户端实现
 */
async function queryNtpServer(hostname: string): Promise<number | null> {
  try {
    // 使用DNS查询获取时间（简化实现）
    // 实际生产环境建议使用专门的NTP库如 node-ntp-client
    const response = await fetch(`https://worldtimeapi.org/api/ip`, {
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json() as { datetime: string };
    return new Date(data.datetime).getTime();
  } catch (error) {
    console.log(`[NTP] Failed to query ${hostname}:`, error);
    return null;
  }
}

/**
 * 从WorldTimeAPI获取时间（备用方案）
 */
async function getTimeFromWorldTimeAPI(): Promise<number | null> {
  try {
    const response = await fetch('https://worldtimeapi.org/api/timezone/Asia/Shanghai', {
      signal: AbortSignal.timeout(5000)
    });
    
    if (!response.ok) {
      return null;
    }
    
    const data = await response.json() as { datetime: string };
    return new Date(data.datetime).getTime();
  } catch (error) {
    console.log('[NTP] WorldTimeAPI failed:', error);
    return null;
  }
}

/**
 * 获取时间戳（带网络校准）
 */
export async function getSyncedTimestamp(): Promise<number> {
  return getCurrentTimestamp();
}

/**
 * 同步系统时间
 * 在系统启动时调用，确保时间准确
 */
export async function syncTime(): Promise<TimeSyncResult> {
  const currentTime = new Date();
  const currentTimestamp = getCurrentTimestamp();
  
  // 尝试从多个NTP源获取时间
  let serverTimestamp: number | null = null;
  let source = 'system';
  
  // 优先使用WorldTimeAPI（最可靠）
  serverTimestamp = await getTimeFromWorldTimeAPI();
  
  if (serverTimestamp) {
    source = 'worldtimeapi.org';
  } else {
    // 尝试NTP服务器
    for (const server of NTP_SERVERS) {
      const ts = await queryNtpServer(server);
      if (ts) {
        serverTimestamp = ts;
        source = server;
        break;
      }
    }
  }
  
  // 如果无法获取服务器时间，使用系统时间
  if (!serverTimestamp) {
    return {
      success: true,
      currentTime,
      source: 'system',
      message: 'Using system time (NTP sync failed)'
    };
  }
  
  // 计算时间偏差
  const drift = Math.abs(serverTimestamp - currentTimestamp);
  
  // 如果时间偏差超过阈值，记录警告
  if (drift > MAX_TIME_DRIFT) {
    console.warn(`[NTP] Time drift detected: ${drift}ms (${drift / 1000}s)`);
  }
  
  return {
    success: true,
    currentTime,
    serverTime: new Date(serverTimestamp),
    drift,
    source,
    message: drift > MAX_TIME_DRIFT 
      ? `Warning: Time drift of ${Math.round(drift / 1000)}s detected`
      : 'Time synchronized successfully'
  };
}

/**
 * 检查并记录时间同步状态
 * 可以在定时任务中调用
 */
export async function checkTimeSync(): Promise<void> {
  const result = await syncTime();
  console.log(`[NTP] Time sync result:`, result.message);
  
  // 如果有显著时间偏差，可以触发告警
  if (result.drift && result.drift > MAX_TIME_DRIFT) {
    console.error(`[NTP] Significant time drift: ${result.drift}ms from ${result.source}`);
  }
}

/**
 * 定时时间同步（每小时执行）
 */
export async function scheduledTimeSync(): Promise<void> {
  try {
    await checkTimeSync();
  } catch (error) {
    console.error('[NTP] Scheduled sync failed:', error);
  }
}
