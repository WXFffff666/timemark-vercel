import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createEvent, getEventsByUserId, updateEvent, deleteEvent, deleteEventsByIds } from '../services/event.service.js';
import { createEventSchema, updateEventSchema } from '@timemark/shared';
import { query } from '../db/index.js';
import type { User } from '@timemark/shared';

const events = new Hono<{ Variables: { user: User } }>();

events.use('*', authMiddleware);

events.get('/', async (c) => {
  const user = c.get('user');
  const userEvents = await getEventsByUserId(user.id);
  return c.json({ success: true, data: userEvents });
});

events.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const parsed = createEventSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid input', details: parsed.error }, 400);
  }

  const event = await createEvent(user.id, parsed.data);
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
  const channels = event.notification_channels || [];
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

  const success = await updateEvent(id, user.id, parsed.data);
  if (!success) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }

  return c.json({ success: true });
});

events.delete('/batch', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body?.ids) ? body.ids.filter((item: unknown) => typeof item === 'string') : [];

  if (ids.length === 0) {
    return c.json({ success: false, error: 'Invalid ids' }, 400);
  }

  const deleted = await deleteEventsByIds(ids, user.id);
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
    const { csvData } = body;
    
    if (!csvData || typeof csvData !== 'string') {
      return c.json({ success: false, error: 'csvData is required' }, 400);
    }
    
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
