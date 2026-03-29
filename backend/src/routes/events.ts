import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { createEvent, getEventsByUserId, updateEvent, deleteEvent } from '../services/event.service.js';
import { createEventSchema, updateEventSchema } from '@timemark/shared';
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

events.put('/:id', async (c) => {
  const user = c.get('user');
  const id = c.req.param('id');
  const body = await c.req.json();
  const parsed = updateEventSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ success: false, error: 'Invalid input' }, 400);
  }

  const success = await updateEvent(id, user.id, parsed.data);
  if (!success) {
    return c.json({ success: false, error: 'Event not found' }, 404);
  }

  return c.json({ success: true });
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
  const channels = event.notification_channels || [];
  
  if (channels.length === 0) {
    return c.json({ success: false, error: 'No notification channels configured' }, 400);
  }
  
  try {
    await sendNotifications(event, user.id, channels);
    return c.json({ success: true, message: 'Test notification sent' });
  } catch (error) {
    return c.json({ success: false, error: 'Failed to send notification' }, 500);
  }
});

export default events;
