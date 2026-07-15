import { Hono } from 'hono';
import { createCipheriv, randomBytes, scryptSync } from 'crypto';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../db/index.js';
import { backupImportSchema } from '@timemark/shared';
import type { User } from '@timemark/shared';

const backup = new Hono<{ Variables: { user: User } }>();
backup.use('*', authMiddleware);

function encryptBackupPayload(json: string, password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: enc.toString('base64'),
  });
}

// Export all user data as JSON
backup.get('/export', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const encrypt = c.req.query('encrypt') === '1';
  
  const [events, mappings, templates] = await Promise.all([
    query('SELECT * FROM events WHERE user_id = $1', [userId]),
    query('SELECT * FROM relationship_mappings WHERE user_id = $1', [userId]),
    query('SELECT * FROM event_templates WHERE user_id = $1', [userId]),
  ]);
  
  const payload = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    events: events.rows,
    relationshipMappings: mappings.rows,
    eventTemplates: templates.rows,
  };

  c.header('Content-Disposition', `attachment; filename="timemark-backup-${new Date().toISOString().split('T')[0]}.json"`);
  c.header('Content-Type', 'application/json');
  return c.json(payload);
});

// C27: 加密备份（密码通过 POST body，避免 query 泄露）
backup.post('/export-encrypted', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const { password } = await c.req.json().catch(() => ({}));
  if (!password || String(password).length < 8) {
    return c.json({ success: false, error: '加密导出需要至少 8 位密码' }, 400);
  }

  const [events, mappings, templates] = await Promise.all([
    query('SELECT * FROM events WHERE user_id = $1', [userId]),
    query('SELECT * FROM relationship_mappings WHERE user_id = $1', [userId]),
    query('SELECT * FROM event_templates WHERE user_id = $1', [userId]),
  ]);

  const payload = JSON.stringify({
    version: '1.0',
    exportedAt: new Date().toISOString(),
    events: events.rows,
    relationshipMappings: mappings.rows,
    eventTemplates: templates.rows,
  });

  c.header('Content-Disposition', `attachment; filename="timemark-backup-encrypted-${new Date().toISOString().split('T')[0]}.json"`);
  c.header('Content-Type', 'application/json');
  return c.body(encryptBackupPayload(payload, String(password)));
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
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
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
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [userId, mapping.event_id || 0, mapping.from_relation, mapping.to_relation, mapping.recipient_email || null, mapping.recipient_type || null]
        );
        imported.mappings++;
      }
    }
    
    if (Array.isArray(data.eventTemplates)) {
      for (const template of data.eventTemplates) {
        await query(
          `INSERT INTO event_templates (user_id, event_type, template_content) VALUES ($1, $2, $3) ON CONFLICT (user_id, event_type) DO NOTHING`,
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
