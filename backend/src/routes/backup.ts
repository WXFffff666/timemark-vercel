import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { backupImportSchema } from '@timemark/shared';
import type { User } from '@timemark/shared';

const backup = new Hono<{ Variables: { user: User } }>();
backup.use('*', authMiddleware);

// Export all user data as JSON
backup.get('/export', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  
  const [events, mappings, templates] = await Promise.all([
    query('SELECT * FROM events WHERE user_id = ?', [userId]),
    query('SELECT * FROM relationship_mappings WHERE user_id = ?', [userId]),
    query('SELECT * FROM event_templates WHERE user_id = ?', [userId]),
  ]);
  
  c.header('Content-Disposition', `attachment; filename="timemark-backup-${new Date().toISOString().split('T')[0]}.json"`);
  c.header('Content-Type', 'application/json');
  return c.json({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    events: events.rows,
    relationshipMappings: mappings.rows,
    eventTemplates: templates.rows,
  });
});

// Import data from JSON
backup.post('/import', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  
  try {
    const body = await c.req.json();
    const parsed = backupImportSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: 'Validation failed', details: parsed.error.flatten() }, 400);
    }
    
    const data = parsed.data;
    let imported = { events: 0, mappings: 0, templates: 0 };
    
    if (Array.isArray(data.events)) {
      for (const event of data.events) {
        await query(
          `INSERT INTO events (user_id, name, type, date, calendar_type, lunar_date, reminder_config, notification_channels, person_name, birth_date, birth_date_lunar, reminder_recipient_name, reminder_recipient_email)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [userId, event.name, event.type, event.date, event.calendar_type || 'gregorian',
           event.lunar_date || null, typeof event.reminder_config === 'string' ? event.reminder_config : JSON.stringify(event.reminder_config || {}),
           typeof event.notification_channels === 'string' ? event.notification_channels : JSON.stringify(event.notification_channels || []),
           event.person_name || null, event.birth_date || null, event.birth_date_lunar || null,
           event.reminder_recipient_name || null, event.reminder_recipient_email || null]
        );
        imported.events++;
      }
    }
    
    if (Array.isArray(data.relationshipMappings)) {
      for (const mapping of data.relationshipMappings) {
        await query(
          `INSERT INTO relationship_mappings (user_id, event_id, from_relation, to_relation, recipient_email, recipient_type)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [userId, mapping.event_id || 0, mapping.from_relation, mapping.to_relation, mapping.recipient_email || null, mapping.recipient_type || null]
        );
        imported.mappings++;
      }
    }
    
    if (Array.isArray(data.eventTemplates)) {
      for (const template of data.eventTemplates) {
        await query(
          `INSERT OR REPLACE INTO event_templates (user_id, event_type, template_content) VALUES (?, ?, ?)`,
          [userId, template.event_type, template.template_content]
        );
        imported.templates++;
      }
    }
    
    return c.json({ success: true, data: imported });
  } catch (error: any) {
    return c.json({ success: false, error: error.message || 'Import failed' }, 500);
  }
});

export default backup;
