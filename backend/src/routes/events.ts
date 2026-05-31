import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createEvent, getEventsByUserId, getEventsByUserIdPaginated, updateEvent, deleteEvent, deleteEventsByIds } from '../services/event.service.js';
import { createEventSchema, updateEventSchema, batchDeleteSchema, csvImportSchema } from '@timemark/shared';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';

const events = new Hono<{ Variables: { user: User } }>();

events.use('*', authMiddleware);

events.get('/', async (c) => {
  const user = c.get('user');
  
  // 解析分页参数
  const page = parseInt(c.req.query('page') || '1', 10);
  const limit = parseInt(c.req.query('limit') || '50', 10);
  const offset = (page - 1) * limit;
  
  // 获取分页数据
  const result = await getEventsByUserIdPaginated(user.id, limit, offset);
  
  return c.json({
    success: true,
    data: result.events,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

events.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createEventSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid input', details: parsed.error }, 400);
  }

  // Validate notification_account_ids if provided
  const accountIds = parsed.data.reminderConfig?.accountIds;
  if (accountIds && accountIds.length > 0) {
    const userId = Number(user.id);
    const numericIds = accountIds.map((id: string) => Number(id)).filter((id: number) => !isNaN(id));
    
    if (numericIds.length > 0) {
      const placeholders = numericIds.map((_: number, i: number) => `$${i + 2}`).join(', ');
      const result = await query(
        `SELECT id FROM notification_accounts WHERE user_id = $1 AND is_active = 1 AND id IN (${placeholders})`,
        [userId, ...numericIds]
      );
      const validIds = new Set(result.rows.map((r: any) => r.id));
      const invalidIds = numericIds.filter((id: number) => !validIds.has(id));
      
      if (invalidIds.length > 0) {
        return c.json({ 
          success: false, 
          error: `Invalid notification account IDs: ${invalidIds.join(', ')}. Accounts must exist and be active.` 
        }, 400);
      }
    }
  }

  const event = await createEvent(user.id, parsed.data);
  
  // 事件创建后立即检查是否需要发送提醒
  // 这样可以确保不会错过即将到来的提醒时间
  try {
    const { sendReminders } = await import('../jobs/tasks.js');
    await sendReminders();
  } catch (error) {
    console.error('[POST /events] Failed to check reminders after event creation:', error);
  }
  
  return c.json({ success: true, data: event }, 201);
});

events.post('/:id/test-send', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const { sendNotifications } = await import('../services/notifications/index.js');
  const { query } = await import('../db/index.js');
  
  const result = await query('SELECT * FROM events WHERE id = $1 AND user_id = $2', [id, user.id]);
  if (result.rows.length === 0) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }
  
  const event = result.rows[0];
  console.log('[test-send] Event data:', JSON.stringify(event, null, 2));
  const rawChannels = event.notification_channels;
  const channels = typeof rawChannels === 'string' ? JSON.parse(rawChannels) : (rawChannels || []);
  console.log('[test-send] Channels:', channels);

  if (channels.length === 0) {
    return c.json({ success: false, error: 'No notification channels configured' }, 400);
  }

  try {
    console.log('[test-send] Calling sendNotifications with userId:', user.id);
    await sendNotifications(event, Number(user.id), channels);
    console.log('[test-send] sendNotifications completed');
    return c.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    console.error('[test-send] Error:', error);
    return c.json({ success: false, error: 'Failed to send notification' }, 500);
  }
});

events.put('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  console.log('[PUT /events/:id] Raw body:', JSON.stringify(body));
  const parsed = updateEventSchema.safeParse(body);

  if (!parsed.success) {
    console.log('[PUT /events/:id] Zod validation failed:', parsed.error.flatten());
    return c.json({ success: false, error: 'Invalid input', details: parsed.error.flatten() }, 400);
  }

  // Validate notification_account_ids if provided
  const accountIds = parsed.data.reminderConfig?.accountIds;
  if (accountIds && accountIds.length > 0) {
    const userId = Number(user.id);
    const numericIds = accountIds.map((id: string) => Number(id)).filter((id: number) => !isNaN(id));
    
    if (numericIds.length > 0) {
      const placeholders = numericIds.map((_: number, i: number) => `$${i + 2}`).join(', ');
      const result = await query(
        `SELECT id FROM notification_accounts WHERE user_id = $1 AND is_active = 1 AND id IN (${placeholders})`,
        [userId, ...numericIds]
      );
      const validIds = new Set(result.rows.map((r: any) => r.id));
      const invalidIds = numericIds.filter((id: number) => !validIds.has(id));
      
      if (invalidIds.length > 0) {
        return c.json({ 
          success: false, 
          error: `Invalid notification account IDs: ${invalidIds.join(', ')}. Accounts must exist and be active.` 
        }, 400);
      }
    }
  }

  const success = await updateEvent(id, user.id, parsed.data);
  if (!success) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }

  // 事件更新后立即检查是否需要发送提醒
  // 这样可以确保不会错过即将到来的提醒时间
  try {
    const { sendReminders } = await import('../jobs/tasks.js');
    await sendReminders();
  } catch (error) {
    console.error('[PUT /events/:id] Failed to check reminders after event update:', error);
  }

  return c.json({ success: true });
});

events.delete('/batch', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = batchDeleteSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  const deleted = await deleteEventsByIds(parsed.data.ids, user.id);
  return c.json({ success: true, data: { deleted } });
});

events.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const success = await deleteEvent(id, user.id);

  if (!success) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }

  return c.json({ success: true });
});

// CSV Import endpoint
events.post('/import-csv', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  
  try {
    const body = await c.req.json();
    const parsed = csvImportSchema.safeParse(body);
    
    if (!parsed.success) {
      return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    
    const { csvData } = parsed.data;
    
    const lines = csvData.split('\n').filter((line: string) => line.trim());
    const headers = lines[0].split(',').map((h: string) => h.trim().toLowerCase());
    
    let imported = 0;
    const errors: string[] = [];
    
    for (let i = 1; i < lines.length; i++) {
      try {
        const values = lines[i].split(',').map((v: string) => v.trim());
        const row: Record<string, string> = {};
        headers.forEach((h: string, idx: number) => { row[h] = values[idx] || ''; });
        
        if (!row.name || !row.date) {
          errors.push(`Row ${i + 1}: missing name or date`);
          continue;
        }
        
        await query(
          `INSERT INTO events (user_id, name, type, date, calendar_type, reminder_config, notification_channels)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [userId, row.name, row.type || 'other', row.date, row.calendar_type || 'gregorian',
           JSON.stringify({ enabled: true, daysBeforeList: [1, 3, 7] }), JSON.stringify([])]
        );
        imported++;
      } catch (rowError: any) {
        errors.push(`Row ${i + 1}: ${rowError.message}`);
      }
    }
    
    return c.json({ success: true, data: { imported, errors } });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'CSV import failed' }, 500);
  }
});

export default events;
