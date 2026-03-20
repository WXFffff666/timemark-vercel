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

export default events;
