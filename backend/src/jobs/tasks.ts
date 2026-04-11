import { query } from '../db/index.js';
import { Lunar, Solar } from 'lunar-javascript';
import { sendNotifications } from '../services/notifications/index.js';
import { getRelationshipMappings } from '../services/config.service.js';

/**
 * 应用关系映射转换事件名称
 */
function applyRelationshipMapping(
  eventName: string,
  mappings: any[],
  recipientEmail?: string,
  recipientType?: string
): string {
  if (!mappings || mappings.length === 0) {
    return eventName;
  }

  // 优先通过收件人类型匹配
  if (recipientType) {
    const typeMapping = mappings.find(m => m.recipient_type === recipientType);
    if (typeMapping) {
      return eventName.replace(typeMapping.from_relation, typeMapping.to_relation);
    }
  }

  // 其次通过收件人邮箱匹配
  if (recipientEmail) {
    const emailMapping = mappings.find(m => m.recipient_email === recipientEmail);
    if (emailMapping) {
      return eventName.replace(emailMapping.from_relation, emailMapping.to_relation);
    }
  }

  // 最后尝试模糊匹配
  for (const mapping of mappings) {
    if (eventName.includes(mapping.from_relation)) {
      return eventName.replace(mapping.from_relation, mapping.to_relation);
    }
  }

  return eventName;
}

export async function sendReminders() {
  console.log('[Task] Checking reminders...');
  
  // 获取今天日期（使用北京时间）
  const now = new Date();
  const timeZone = 'Asia/Shanghai';
  const today = new Date(now.toLocaleString('en-US', { timeZone })).toISOString().split('T')[0];
  const tomorrow = addDays(today, 1);
  const dayAfterTomorrow = addDays(today, 3);
  
  // 查询所有事件
  const allEvents = await query('SELECT * FROM events');
  
  // 筛选需要提醒的事件
  const eventsToRemind: Array<{ id: number; user_id: number; name: string; date: string; lunar_date: any; calendar_type: string; notification_channels: string[]; notification_account_ids: any }> = [];
  
  for (const event of allEvents.rows) {
    const calendarType = event.calendar_type;
    let eventTargetDate: Date | null = null;
    
    if (calendarType === 'gregorian') {
      // 公历事件：直接比较日期
      const eventDate = event.date;
      if (eventDate === today || eventDate === tomorrow || eventDate === dayAfterTomorrow) {
        eventTargetDate = new Date(eventDate);
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
            const tryDate = new Date(trySolar.getYear(), trySolar.getMonth() - 1, trySolar.getDay());
            const tryDateStr = tryDate.toISOString().split('T')[0];
            
            if (tryDateStr === today || tryDateStr === tomorrow || tryDateStr === dayAfterTomorrow) {
              eventTargetDate = tryDate;
              break;
            }
          }
        }
      } catch (error) {
        console.error(`[Task] Failed to parse lunar date for event ${event.id}:`, error);
      }
    }
    
    if (eventTargetDate) {
      eventsToRemind.push({ ...event, targetDate: eventTargetDate });
    }
  }
  
  console.log(`[Task] Found ${eventsToRemind.length} events to remind`);
  
  for (const event of eventsToRemind) {
    const channels = event.notification_channels || [];
    if (channels.length > 0) {
      try {
        // 获取关系映射并转换事件名称
        const mappings = await getRelationshipMappings(event.user_id, event.id);
        const mappedEvent = { 
          ...event, 
          name: applyRelationshipMapping(event.name, mappings) 
        };
        
        await sendNotifications(mappedEvent, event.user_id, channels);
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
  const result = await query('DELETE FROM sessions WHERE expires_at < NOW()');
  console.log(`[Task] Cleaned up ${result.rowCount ?? 0} expired sessions`);
  
  // 清理30天前的登录日志
  console.log('[Task] Cleaning up old login logs...');
  const loginLogsResult = await query(
    "DELETE FROM login_logs WHERE login_time < NOW() AT TIME ZONE 'Asia/Shanghai' - INTERVAL '30 days'"
  );
  console.log(`[Task] Cleaned up ${loginLogsResult.rowCount ?? 0} old login logs`);
  
  // 清理30天前的事件触发日志
  console.log('[Task] Cleaning up old event trigger logs...');
  const triggerResult = await query(
    "DELETE FROM event_trigger_logs WHERE created_at < NOW() AT TIME ZONE 'Asia/Shanghai' - INTERVAL '30 days'"
  );
  console.log(`[Task] Cleaned up ${triggerResult.rowCount ?? 0} old event trigger logs`);
}

function addDays(dateStr: string, days: number): string {
  const date = new Date(dateStr);
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
}
