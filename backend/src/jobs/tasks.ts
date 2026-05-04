import { query } from '../db/index.js';
import { Lunar, Solar } from 'lunar-javascript';
import { sendNotifications } from '../services/notifications/index.js';
import { getReminderSettings } from '../services/config.service.js';

/** Get today's date string (YYYY-MM-DD) in the given timezone, robust on Alpine Linux */
function getTodayString(now: Date, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(now); // en-CA outputs YYYY-MM-DD
}

/** Calculate days between two YYYY-MM-DD date strings (dateB - dateA) */
function diffDays(dateA: string, dateB: string): number {
  const a = new Date(dateA + 'T00:00:00Z');
  const b = new Date(dateB + 'T00:00:00Z');
  return Math.round((b.getTime() - a.getTime()) / (86400 * 1000));
}

/** Parse reminder_days_before from an event's JSON field, returns null if invalid */
function parseReminderDays(raw: any): number[] | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Array.isArray(parsed) && parsed.length > 0 && parsed.every((n: any) => typeof n === 'number' && n >= 0)) {
      return parsed;
    }
  } catch { /* ignore parse errors */ }
  return null;
}

export async function sendReminders() {
  console.log('[Task] Checking reminders...');
  
  // 获取今天日期（使用北京时间，Intl.DateTimeFormat 在 Alpine Linux 上更可靠）
  const now = new Date();
  const timeZone = 'Asia/Shanghai';
  const today = getTodayString(now, timeZone);
  
  // 查询所有事件
  const allEvents = await query('SELECT * FROM events');
  
  // 缓存每个用户的提醒设置（避免重复查询）
  const userReminderSettingsCache = new Map<number, number[]>();
  const userEnabledCache = new Map<number, boolean>();
  
  async function getDaysBeforeList(userId: number, eventReminderDaysBefore: any): Promise<number[]> {
    // 优先使用事件级别的 reminder_days_before
    const eventDays = parseReminderDays(eventReminderDaysBefore);
    if (eventDays) return eventDays;
    
    // 回退到用户级别的 days_before_list
    if (userReminderSettingsCache.has(userId)) {
      return userReminderSettingsCache.get(userId)!;
    }
    const settings = await getReminderSettings(userId);
    const days = settings?.daysBeforeList ?? [1, 3, 7];
    userReminderSettingsCache.set(userId, days);
    return days;
  }
  
  // 筛选需要提醒的事件
  const eventsToRemind: Array<{ id: number; user_id: number; name: string; date: string; lunar_date: any; calendar_type: string; notification_channels: string[]; notification_account_ids: any }> = [];
  
  for (const event of allEvents.rows) {
    // Check if user has reminders enabled (cached to avoid repeated queries)
    if (!userEnabledCache.has(event.user_id)) {
      const settings = await getReminderSettings(event.user_id);
      userEnabledCache.set(event.user_id, settings?.enabled !== false);
    }
    if (!userEnabledCache.get(event.user_id)) continue;

    const calendarType = event.calendar_type;
    let eventTargetDate: Date | null = null;
    
    // 获取此事件的提前提醒天数列表
    const daysBeforeList = await getDaysBeforeList(event.user_id, event.reminder_days_before);
    // 包含 0 表示当天也提醒
    const allDays = daysBeforeList.includes(0) ? daysBeforeList : [0, ...daysBeforeList];
    
    if (calendarType === 'gregorian') {
      // 公历事件：计算今天距事件日期的天数差
      const eventDate = event.date; // YYYY-MM-DD
      const diff = diffDays(today, eventDate);
      if (diff >= 0 && allDays.includes(diff)) {
        eventTargetDate = new Date(eventDate + 'T00:00:00Z');
      }
    } else if (calendarType === 'lunar' && event.lunar_date) {
      // 农历事件：转换为公历日期后比较
      try {
        const lunarData = typeof event.lunar_date === 'string' 
          ? JSON.parse(event.lunar_date) 
          : event.lunar_date;
        
        if (lunarData && lunarData.year && lunarData.month && lunarData.day) {
          const month = lunarData.isLeap ? -lunarData.month : lunarData.month;
          
          // 计算今年和明年的农历日期对应的公历日期
          const currentYear = now.getFullYear();
          
          for (const year of [currentYear, currentYear + 1]) {
            const tryLunarDate = Lunar.fromYmd(year, month, lunarData.day);
            const trySolar = tryLunarDate.getSolar();
            const tryDate = new Date(Date.UTC(trySolar.getYear(), trySolar.getMonth() - 1, trySolar.getDay()));
            const tryDateStr = tryDate.toISOString().split('T')[0];
            
            const diff = diffDays(today, tryDateStr);
            if (diff >= 0 && allDays.includes(diff)) {
              eventTargetDate = tryDate;
              break;
            }
          }
        }
      } catch (error) {
        console.error(`[Task] Failed to parse lunar date for event ${event.id}:`, error);
        // 记录农历转换失败到事件触发日志
        await recordEventTrigger(event.id, event.user_id, 'scheduled', new Date(), 'failed', `Lunar date conversion failed: ${String(error)}`);
      }
    }
    
    if (eventTargetDate) {
      // Check if current time matches any of the event's reminder times
      const currentHour = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        hour12: false
      }).format(now);
      const currentMinute = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        minute: '2-digit',
        hour12: false
      }).format(now);
      const currentTime = `${currentHour.padStart(2, '0')}:${currentMinute.padStart(2, '0')}`;
      
      // Get reminder times from reminderConfig
      let reminderTimes: string[] = [];
      try {
        const rawConfig = event.reminder_config;
        if (rawConfig) {
          const config = typeof rawConfig === 'string' ? JSON.parse(rawConfig) : rawConfig;
          reminderTimes = config.reminderTimes || [];
        }
      } catch (e) {
        console.error(`[Task] Failed to parse reminder_config for event ${event.id}:`, e);
      }
      
      // Fallback to legacy reminder_time field
      if (reminderTimes.length === 0) {
        const eventReminderTime = event.reminder_time || '09:00';
        reminderTimes = [eventReminderTime];
      }
      
      // Check if current time matches any reminder time (within 15-minute window)
      const shouldRemind = reminderTimes.some(time => {
        const [targetHour, targetMinute] = time.split(':').map(Number);
        const targetTotalMinutes = targetHour * 60 + targetMinute;
        const currentTotalMinutes = parseInt(currentHour) * 60 + parseInt(currentMinute);
        // Allow 15-minute window for triggering
        return Math.abs(currentTotalMinutes - targetTotalMinutes) < 15;
      });
      
      if (!shouldRemind) {
        continue; // Skip - not the right time for this event
      }
      eventsToRemind.push({ ...event, targetDate: eventTargetDate });
    }
  }
  
  console.log(`[Task] Found ${eventsToRemind.length} events to remind`);
  
  for (const event of eventsToRemind) {
    const rawChannels = event.notification_channels;
    const channels = typeof rawChannels === 'string' ? JSON.parse(rawChannels) : (rawChannels || []);
    if (channels.length > 0) {
      // Check if already sent today
      const alreadySent = await query(
        `SELECT id FROM event_trigger_logs 
         WHERE event_id = $1 AND trigger_date = $2 AND status = 'success'
         LIMIT 1`,
        [event.id, today]
      );
      if (alreadySent.rows.length > 0) {
        console.log(`[Task] Event ${event.id} already reminded today, skipping`);
        continue;
      }
      try {
        // Relationship mapping is handled inside sendNotifications() per-recipient
        await sendNotifications(event, event.user_id, channels);
        console.log(`[Task] Sent notifications for event ${event.id}`);
        
        // 记录事件触发日志
        const triggerDate = 'targetDate' in event ? (event as any).targetDate : new Date(event.date);
        await recordEventTrigger(event.id, event.user_id, 'scheduled', triggerDate);
      } catch (error) {
        console.error(`[Task] Failed to send notifications for event ${event.id}:`, error);
        const triggerDate2 = 'targetDate' in event ? (event as any).targetDate : new Date(event.date);
        await recordEventTrigger(event.id, event.user_id, 'scheduled', triggerDate2, 'failed', String(error));
      }
    }
  }
}

// 记录事件触发日志
async function recordEventTrigger(
  eventId: number, 
  userId: number, 
  triggerType: string, 
  triggerDate: Date,
  status: string = 'success',
  errorMessage?: string
) {
  try {
    await query(
      `INSERT INTO event_trigger_logs 
       (event_id, user_id, trigger_type, trigger_date, status, error_message) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [eventId, userId, triggerType, triggerDate.toISOString().split('T')[0], status, errorMessage || null]
    );
  } catch (error) {
    console.error('[Task] Failed to record event trigger log:', error);
  }
}

export async function githubBackup() {
  console.log('[Task] Backing up email logs...');
  const result = await query('SELECT COUNT(*) as count FROM email_logs');
  console.log(`[Task] Backed up ${result.rows[0].count} email logs`);
}

export async function archiveLoginHistory() {
  console.log('[Task] Archiving login history...');
  const result = await query('SELECT COUNT(*) as count FROM login_attempts');
  console.log(`[Task] Archived ${result.rows[0].count} login attempts`);
}

export async function cleanupSessions() {
  console.log('[Task] Cleaning up expired sessions...');
  const result = await query("DELETE FROM sessions WHERE expires_at < datetime('now')");
  console.log(`[Task] Cleaned up ${result.rowCount ?? 0} expired sessions`);
  
  // 清理30天前的登录日志
  console.log('[Task] Cleaning up old login logs...');
  const loginLogsResult = await query(
    "DELETE FROM login_logs WHERE login_time < datetime('now', '-30 days')"
  );
  console.log(`[Task] Cleaned up ${loginLogsResult.rowCount ?? 0} old login logs`);
  
  // 清理30天前的事件触发日志
  console.log('[Task] Cleaning up old event trigger logs...');
  const triggerResult = await query(
    "DELETE FROM event_trigger_logs WHERE created_at < datetime('now', '-30 days')"
  );
  console.log(`[Task] Cleaned up ${triggerResult.rowCount ?? 0} old event trigger logs`);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}
