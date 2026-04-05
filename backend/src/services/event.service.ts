import { query } from '../db/index.js';
import { randomUUID } from 'crypto';
import type { Event, CreateEventRequest } from '@timemark/shared';

export async function createEvent(userId: string, data: CreateEventRequest): Promise<Event> {
  const id = randomUUID();
  
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
  
  await query(
    `INSERT INTO events (id, user_id, name, type, date, calendar_type, lunar_date, reminder_config, relationship_mapping_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, userId, data.name, data.type, data.date, data.calendarType, 
      data.lunarDate ? JSON.stringify(data.lunarDate) : null, 
      JSON.stringify(reminderConfig),
      data.relationshipMappingId || null]
  );

  return { id, userId, ...data, reminderConfig, createdAt: new Date().toISOString() };
}

export async function getEventsByUserId(userId: string): Promise<Event[]> {
  const result = await query('SELECT * FROM events WHERE user_id = $1 ORDER BY date ASC', [userId]);
  return result.rows.map((row: any) => {
    let reminderConfig: any = {};
    try {
      reminderConfig = row.reminder_config ? JSON.parse(row.reminder_config) : {};
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
