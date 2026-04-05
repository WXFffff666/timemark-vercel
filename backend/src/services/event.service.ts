import { query } from '../db/index.js';
import type { Event, CreateEventRequest } from '@timemark/shared';

export async function createEvent(userId: string, data: CreateEventRequest): Promise<Event> {
  console.log('[createEvent] Received userId:', userId, 'type:', typeof userId);
  
  // Convert userId from string to integer
  const numericUserId = parseInt(userId, 10);
  console.log('[createEvent] Parsed numericUserId:', numericUserId, 'isNaN:', isNaN(numericUserId));
  
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
  };
  
  const reminderConfig = data.reminderConfig 
    ? { ...defaultConfig, ...data.reminderConfig }
    : defaultConfig;
  
  console.log('[createEvent] About to insert with user_id:', numericUserId);
  
  try {
    // Don't specify id - let the database auto-increment (SERIAL)
    await query(
      `INSERT INTO events (user_id, name, type, date, calendar_type, lunar_date, reminder_config, relationship_mapping_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [numericUserId, data.name, data.type, data.date, data.calendarType, 
        data.lunarDate ? JSON.stringify(data.lunarDate) : null, 
        JSON.stringify(reminderConfig),
        data.relationshipMappingId || null]
    );
    // Get the created event's id
    const result = await query('SELECT lastval() as id');
    const eventId = result.rows[0].id;
    console.log('[createEvent] Insert successful! Event ID:', eventId);
    
    return { id: eventId, userId, ...data, reminderConfig, createdAt: new Date().toISOString() };
  } catch (insertError) {
    console.error('[createEvent] INSERT ERROR:', insertError);
    throw insertError;
  }
}

export async function getEventsByUserId(userId: string): Promise<Event[]> {
  // Convert userId from UUID string to integer
  const numericUserId = parseInt(userId, 10);
  if (isNaN(numericUserId)) {
    return [];
  }
  
  const result = await query('SELECT * FROM events WHERE user_id = $1 ORDER BY date ASC', [numericUserId]);
  return result.rows.map((row: any) => {
    let reminderConfig: any = {};
    try {
      // pg JSON column may return as string or already parsed object
      const rawConfig = row.reminder_config;
      if (rawConfig === null || rawConfig === undefined) {
        reminderConfig = {};
      } else if (typeof rawConfig === 'object') {
        reminderConfig = rawConfig;
      } else if (typeof rawConfig === 'string') {
        reminderConfig = JSON.parse(rawConfig);
      } else {
        console.warn('Unknown reminder_config type:', typeof rawConfig, rawConfig);
        reminderConfig = {};
      }
    } catch (e) {
      console.error('Failed to parse reminder_config:', e, row.reminder_config);
      reminderConfig = {};
    }
    
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      type: row.type,
      date: row.date,
      calendarType: row.calendar_type,
      lunarDate: row.lunar_date ? (() => { try { return JSON.parse(row.lunar_date); } catch { return undefined; } })() : undefined,
      reminderConfig,
      relationshipMappingId: row.relationship_mapping_id?.toString(),
      createdAt: row.created_at,
    };
  });
}

export async function updateEvent(id: string, userId: string, data: Partial<CreateEventRequest>): Promise<boolean> {
  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.name) { updates.push(`name = $${paramIndex++}`); values.push(data.name); }
  if (data.type) { updates.push(`type = $${paramIndex++}`); values.push(data.type); }
  if (data.date) { updates.push(`date = $${paramIndex++}`); values.push(data.date); }
  if (data.calendarType) { updates.push(`calendar_type = $${paramIndex++}`); values.push(data.calendarType); }
  if (data.lunarDate) { updates.push(`lunar_date = $${paramIndex++}`); values.push(JSON.stringify(data.lunarDate)); }
  if (data.reminderConfig) { updates.push(`reminder_config = $${paramIndex++}`); values.push(JSON.stringify(data.reminderConfig)); }
  if (data.relationshipMappingId !== undefined) { updates.push(`relationship_mapping_id = $${paramIndex++}`); values.push(data.relationshipMappingId || null); }

  if (updates.length === 0) return false;

  values.push(id, userId);
  const result = await query(`UPDATE events SET ${updates.join(', ')} WHERE id = $${paramIndex} AND user_id = $${paramIndex + 1}`, values);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteEvent(id: string, userId: string): Promise<boolean> {
  const result = await query('DELETE FROM events WHERE id = $1 AND user_id = $2', [id, userId]);
  return (result.rowCount ?? 0) > 0;
}

export async function deleteEventsByIds(ids: string[], userId: string): Promise<number> {
  if (ids.length === 0) return 0;

  const result = await query(
    'DELETE FROM events WHERE user_id = $1 AND id::text = ANY($2::text[])',
    [userId, ids]
  );
  return result.rowCount ?? 0;
}
