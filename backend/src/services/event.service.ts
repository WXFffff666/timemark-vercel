import { query } from '../db/index.js';
import type { Event, CreateEventRequest, RecurringConfig, ReminderConfig, EventType, CalendarType } from '@timemark/shared';

interface EventRow {
  id: number;
  user_id: number;
  name: string;
  type: string;
  date: string | Date;
  calendar_type: string;
  lunar_date: string | null;
  reminder_config: string | null;
  notification_channels: string | null;
  notification_account_ids: string | null;
  relationship_mapping_id: number | null;
  person_name: string | null;
  birth_date: string | null;
  birth_date_lunar: string | null;
  reminder_recipient_name: string | null;
  reminder_recipient_email: string | null;
  recurring_config: string | null;
  next_occurrence: string | null;
  created_at: string;
}

interface UpdateEventData {
  name?: string;
  type?: string;
  date?: string;
  calendarType?: string;
  lunarDate?: { year: number; month: number; day: number; isLeap: boolean } | null;
  reminderConfig?: Partial<ReminderConfig> | null;
  recurringConfig?: Partial<RecurringConfig> | null;
  personName?: string | null;
  birthDate?: string | null;
  birthDateLunar?: string | null;
  reminderRecipientName?: string | null;
  reminderRecipientEmail?: string | null;
  relationshipMappingId?: string | null;
}

export async function createEvent(userId: string, data: CreateEventRequest): Promise<Event> {
  // Convert userId from string to integer
  const numericUserId = parseInt(userId, 10);
  
  if (isNaN(numericUserId)) {
    console.error('[createEvent] ERROR: Invalid user ID - received:', userId);
    throw new Error('Invalid user ID: ' + userId);
  }
  
  // Ensure reminderConfig has required fields with defaults
  const defaultConfig = {
    enabled: true,
    daysBeforeList: [1, 3, 7],
    emailRecipients: [] as string[],
    channels: [] as string[],
    accountIds: [] as string[],
  };
  
  const reminderConfig = data.reminderConfig 
    ? { ...defaultConfig, ...data.reminderConfig }
    : defaultConfig;
  
  // Extract channels for separate column storage
  const notificationChannels = reminderConfig.channels || [];
  
  // Extract notification account IDs from reminderConfig
  const notificationAccountIds = (reminderConfig.accountIds || []).map((id: string) => Number(id)).filter((id: number) => !isNaN(id));
  
  // 计算下次发生日期（如果是重复事件）
  let nextOccurrence = null;
  if (data.recurringConfig?.enabled) {
    nextOccurrence = calculateNextOccurrence(data.date, data.recurringConfig);
  }
  
  try {
    // Don't specify id - let the database auto-increment (SERIAL)
    const result = await query(
      `INSERT INTO events (user_id, name, type, date, calendar_type, lunar_date, reminder_config, notification_channels, notification_account_ids, relationship_mapping_id, person_name, birth_date, birth_date_lunar, reminder_recipient_name, reminder_recipient_email, recurring_config, next_occurrence) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING id`,
      [numericUserId, data.name, data.type, data.date, data.calendarType, 
        data.lunarDate ? JSON.stringify(data.lunarDate) : null, 
        JSON.stringify(reminderConfig),
        JSON.stringify(notificationChannels),
        JSON.stringify(notificationAccountIds),
        data.relationshipMappingId || null,
        data.personName || null,
        data.birthDate || null,
        data.birthDateLunar || null,
        data.reminderRecipientName || null,
        data.reminderRecipientEmail || null,
        data.recurringConfig ? JSON.stringify(data.recurringConfig) : null,
        nextOccurrence]
    );
    const eventId = result.rows[0].id;
    
    return { id: eventId, userId, ...data, reminderConfig, nextOccurrence, createdAt: new Date().toISOString() };
  } catch (insertError) {
    console.error('[createEvent] INSERT ERROR:', insertError);
    throw insertError;
  }
}

/**
 * 计算下次发生日期
 */
function calculateNextOccurrence(date: string, config: RecurringConfig): string | null {
  try {
    const baseDate = new Date(date + 'T00:00:00');
    const now = new Date();
    
    // 如果基础日期已经过了，需要计算下一个发生日期
    let nextDate = new Date(baseDate);
    
    while (nextDate <= now) {
      switch (config.frequency) {
        case 'daily':
          nextDate.setDate(nextDate.getDate() + config.interval);
          break;
        case 'weekly':
          nextDate.setDate(nextDate.getDate() + (7 * config.interval));
          break;
        case 'monthly':
          nextDate.setMonth(nextDate.getMonth() + config.interval);
          break;
        case 'yearly':
          nextDate.setFullYear(nextDate.getFullYear() + config.interval);
          break;
        default:
          return null;
      }
      
      // 检查是否超过结束条件
      if (config.endType === 'date' && config.endDate) {
        const endDate = new Date(config.endDate + 'T00:00:00');
        if (nextDate > endDate) {
          return null;
        }
      }
    }
    
    // 格式化为 YYYY-MM-DD
    return `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}-${String(nextDate.getDate()).padStart(2, '0')}`;
  } catch (error) {
    console.error('[calculateNextOccurrence] Error:', error);
    return null;
  }
}

export async function getEventsByUserId(userId: string): Promise<Event[]> {
  // Convert userId from UUID string to integer
  const numericUserId = parseInt(userId, 10);
  if (isNaN(numericUserId)) {
    return [];
  }
  
  const result = await query('SELECT * FROM events WHERE user_id = $1 ORDER BY date ASC', [numericUserId]);
  return result.rows.map((row: EventRow) => {
    const defaultReminderConfig: ReminderConfig = {
      enabled: true,
      daysBeforeList: [1, 3, 7],
      emailRecipients: [],
    };
    
    let reminderConfig: ReminderConfig = { ...defaultReminderConfig };
    try {
      // pg JSON column may return as string or already parsed object
      const rawConfig = row.reminder_config;
      if (rawConfig === null || rawConfig === undefined) {
        reminderConfig = { ...defaultReminderConfig };
      } else if (typeof rawConfig === 'object') {
        reminderConfig = { ...defaultReminderConfig, ...(rawConfig as Partial<ReminderConfig>) };
      } else if (typeof rawConfig === 'string') {
        const parsed = JSON.parse(rawConfig);
        reminderConfig = { ...defaultReminderConfig, ...parsed };
      } else {
        console.warn('Unknown reminder_config type:', typeof rawConfig, rawConfig);
        reminderConfig = { ...defaultReminderConfig };
      }
    } catch (e) {
      console.error('Failed to parse reminder_config:', e, row.reminder_config);
      reminderConfig = { ...defaultReminderConfig };
    }
    
    // Merge notification_channels from separate column into reminderConfig
    let notificationChannels: string[] = [];
    try {
      const rawChannels = row.notification_channels;
      if (rawChannels) {
        notificationChannels = typeof rawChannels === 'string' ? JSON.parse(rawChannels) : rawChannels;
      }
    } catch (e) {
      console.error('Failed to parse notification_channels:', e);
    }
    // Ensure channels is in reminderConfig
    reminderConfig.channels = notificationChannels;
    
    // Parse recurring config
    let recurringConfig = undefined;
    try {
      const rawRecurring = row.recurring_config;
      if (rawRecurring) {
        recurringConfig = typeof rawRecurring === 'string' ? JSON.parse(rawRecurring) : rawRecurring;
      }
    } catch (e) {
      console.error('Failed to parse recurring_config:', e);
    }
    
    return {
      id: String(row.id),
      userId: String(row.user_id),
      name: row.name,
      type: row.type as EventType,
      // Handle date - PostgreSQL returns Date objects, extract YYYY-MM-DD
      date: (() => {
        try {
          if (row.date instanceof Date) {
            const d = row.date;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          }
          if (typeof row.date === 'string') {
            return row.date.split('T')[0];
          }
          return String(row.date);
        } catch (e) {
          console.warn('Failed to format date:', row.date, e);
          return String(row.date);
        }
      })(),
      calendarType: row.calendar_type as CalendarType,
      lunarDate: row.lunar_date ? (() => { try { return JSON.parse(row.lunar_date); } catch { return undefined; } })() : undefined,
      reminderConfig,
      recurringConfig,
      nextOccurrence: row.next_occurrence || null,
      relationshipMappingId: row.relationship_mapping_id?.toString(),
      // New fields
      personName: row.person_name,
      birthDate: row.birth_date,
      birthDateLunar: row.birth_date_lunar,
      reminderRecipientName: row.reminder_recipient_name,
      reminderRecipientEmail: row.reminder_recipient_email,
      createdAt: row.created_at,
    };
  });
}

export async function getEventsByUserIdPaginated(userId: string, limit: number, offset: number): Promise<{ events: Event[]; total: number }> {
  const numericUserId = parseInt(userId, 10);
  if (isNaN(numericUserId)) {
    return { events: [], total: 0 };
  }
  
  // 获取总数
  const countResult = await query('SELECT COUNT(*) as total FROM events WHERE user_id = $1', [numericUserId]);
  const total = countResult.rows[0]?.total || 0;
  
  // 获取分页数据
  const result = await query(
    'SELECT * FROM events WHERE user_id = $1 ORDER BY date ASC LIMIT $2 OFFSET $3',
    [numericUserId, limit, offset]
  );
  
  const events = result.rows.map((row: EventRow) => {
    const defaultReminderConfig: ReminderConfig = {
      enabled: true,
      daysBeforeList: [1, 3, 7],
      emailRecipients: [],
    };
    
    let reminderConfig: ReminderConfig = { ...defaultReminderConfig };
    try {
      const rawConfig = row.reminder_config;
      if (rawConfig === null || rawConfig === undefined) {
        reminderConfig = { ...defaultReminderConfig };
      } else if (typeof rawConfig === 'object') {
        reminderConfig = { ...defaultReminderConfig, ...(rawConfig as Partial<ReminderConfig>) };
      } else if (typeof rawConfig === 'string') {
        const parsed = JSON.parse(rawConfig);
        reminderConfig = { ...defaultReminderConfig, ...parsed };
      }
    } catch (e) {
      console.error('Failed to parse reminder_config:', e);
    }
    
    let notificationChannels: string[] = [];
    try {
      const rawChannels = row.notification_channels;
      if (rawChannels) {
        notificationChannels = typeof rawChannels === 'string' ? JSON.parse(rawChannels) : rawChannels;
      }
    } catch (e) {
      console.error('Failed to parse notification_channels:', e);
    }
    reminderConfig.channels = notificationChannels;
    
    let recurringConfig = undefined;
    try {
      const rawRecurring = row.recurring_config;
      if (rawRecurring) {
        recurringConfig = typeof rawRecurring === 'string' ? JSON.parse(rawRecurring) : rawRecurring;
      }
    } catch (e) {
      console.error('Failed to parse recurring_config:', e);
    }
    
    return {
      id: String(row.id),
      userId: String(row.user_id),
      name: row.name,
      type: row.type as EventType,
      date: (() => {
        try {
          if (row.date instanceof Date) {
            const d = row.date;
            return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          }
          if (typeof row.date === 'string') {
            return row.date.split('T')[0];
          }
          return String(row.date);
        } catch {
          return String(row.date);
        }
      })(),
      calendarType: row.calendar_type as CalendarType,
      lunarDate: row.lunar_date ? (() => { try { return JSON.parse(row.lunar_date); } catch { return undefined; } })() : undefined,
      reminderConfig,
      recurringConfig,
      nextOccurrence: row.next_occurrence || null,
      relationshipMappingId: row.relationship_mapping_id?.toString(),
      personName: row.person_name,
      birthDate: row.birth_date,
      birthDateLunar: row.birth_date_lunar,
      reminderRecipientName: row.reminder_recipient_name,
      reminderRecipientEmail: row.reminder_recipient_email,
      createdAt: row.created_at,
    };
  });
  
  return { events, total };
}

export async function updateEvent(id: string, userId: string, data: UpdateEventData): Promise<boolean> {
  const numericUserId = parseInt(userId, 10);
  const updates: string[] = [];
  const values: (string | number | null)[] = [];
  let paramIndex = 1;

  if (data.name) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
  if (data.type) { updates.push(`type = $${paramIndex++}`); values.push(data.type); }
  if (data.date) { 
    // Handle date format from frontend - extract YYYY-MM-DD
    const dateStr = data.date.split('T')[0];
    updates.push(`date = $${paramIndex++}`); values.push(dateStr); 
  }
  if (data.calendarType) { updates.push(`calendar_type = $${paramIndex++}`); values.push(data.calendarType); }
  if (data.lunarDate) { updates.push(`lunar_date = $${paramIndex++}`); values.push(JSON.stringify(data.lunarDate)); }
  if (data.reminderConfig) {
    // Extract channels from reminderConfig for separate column storage
    const channels = data.reminderConfig.channels || [];
    updates.push(`reminder_config = $${paramIndex++}`);
    values.push(JSON.stringify(data.reminderConfig));
    // Also update notification_channels column
    updates.push(`notification_channels = $${paramIndex++}`);
    values.push(JSON.stringify(channels));
    // Also update notification_account_ids column
    const accountIds = (data.reminderConfig.accountIds || []).map((id: string) => Number(id)).filter((id: number) => !isNaN(id));
    updates.push(`notification_account_ids = $${paramIndex++}`);
    values.push(JSON.stringify(accountIds));
    
    // Clear today's trigger log when reminder config changes
    // This allows the scheduler to re-trigger with the new configuration
    try {
      await query(
        `DELETE FROM event_trigger_logs WHERE event_id = $1 AND trigger_date = date('now')`,
        [id]
      );
      console.log(`[updateEvent] Cleared trigger logs for event ${id} due to config change`);
    } catch (e) {
      console.error('[updateEvent] Failed to clear trigger logs:', e);
    }
  }
  if (data.relationshipMappingId !== undefined) { updates.push(`relationship_mapping_id = $${paramIndex++}`); values.push(data.relationshipMappingId || null); }
  if (data.personName !== undefined) { updates.push(`person_name = $${paramIndex++}`); values.push(data.personName || null); }
  if (data.birthDate !== undefined) { updates.push(`birth_date = $${paramIndex++}`); values.push(data.birthDate || null); }
  if (data.birthDateLunar !== undefined) { updates.push(`birth_date_lunar = $${paramIndex++}`); values.push(data.birthDateLunar || null); }
  if (data.reminderRecipientName !== undefined) { updates.push(`reminder_recipient_name = $${paramIndex++}`); values.push(data.reminderRecipientName || null); }
  if (data.reminderRecipientEmail !== undefined) { updates.push(`reminder_recipient_email = $${paramIndex++}`); values.push(data.reminderRecipientEmail || null); }
  if (data.recurringConfig !== undefined) { 
    updates.push(`recurring_config = $${paramIndex++}`); 
    values.push(data.recurringConfig ? JSON.stringify(data.recurringConfig) : null);
    // 计算下次发生日期
    if (data.recurringConfig?.enabled && data.recurringConfig?.frequency && data.recurringConfig?.interval && data.date) {
      const nextOccurrence = calculateNextOccurrence(data.date.split('T')[0], data.recurringConfig as RecurringConfig);
      updates.push(`next_occurrence = $${paramIndex++}`);
      values.push(nextOccurrence);
    } else {
      updates.push(`next_occurrence = $${paramIndex++}`);
      values.push(null);
    }
  }

  if (updates.length === 0) return false;

  values.push(id, numericUserId);
  const result = await query(`UPDATE events SET ${updates.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`, values);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteEvent(id: string, userId: string): Promise<boolean> {
  const result = await query('DELETE FROM events WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteEventsByIds(ids: string[], userId: string): Promise<number> {
  if (ids.length === 0) return 0;

  const placeholders = ids.map((_, index) => `$${index + 2}`).join(',');

  const result = await query(
    `DELETE FROM events WHERE user_id = $1 AND CAST(id AS TEXT) IN (${placeholders})`,
    [userId, ...ids]
  );
  return result.rowCount ?? 0;
}
