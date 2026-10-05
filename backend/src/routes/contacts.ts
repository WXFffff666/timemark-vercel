import { Hono } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import {
  createFixedContactSchema,
  updateFixedContactSchema,
  contactSendEmailSchema,
  createInteractionSchema,
  createContactPromiseSchema,
  createGiftRecordSchema,
  formatZodError,
} from '@timemark/shared';
import {
  listFixedContacts,
  createFixedContact,
  updateFixedContact,
  deleteFixedContact,
  validateContactMethods,
} from '../services/contact.service.js';
import {
  createContactPromise,
  createGiftRecord,
  createInteraction,
  listContactTimeline,
  listDueContacts,
} from '../services/contact-crm.service.js';
import { mergeContactMethodsInput } from '@timemark/shared';
import { sendContactEmail } from '../services/contact-send.service.js';
import { query } from '../db/index.js';
import { parseProfileFilter } from './profile-filter.js';

const contacts = new Hono<{ Variables: { user: User } }>();
contacts.use('*', authMiddleware);

/** 分页参数与 /api/expiry 相同：page >= 1，limit 默认 50、上限 200 */
function parsePage(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function parseLimit(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  if (!Number.isFinite(n) || n < 1) return 50;
  return Math.min(n, 200);
}

function parseContactId(raw: string): number | null {
  const id = parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** 互动时间允许 5 分钟时钟偏差，更晚的一律 400 */
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

contacts.get('/', async (c) => {
  const user = c.get('user');
  // 可选档案过滤（checkbox 69）：省略 = 全部档案；他人的档案一律 404。
  const profileFilter = await parseProfileFilter(c, Number(user.id));
  if (profileFilter instanceof Response) return profileFilter;
  const data = await listFixedContacts(Number(user.id), profileFilter);
  return c.json({ success: true, data });
});

contacts.post('/', async (c) => {
  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const parsed = createFixedContactSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const row = await createFixedContact(Number(user.id), parsed.data);
    return c.json({ success: true, data: row }, 201);
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : '创建失败' }, 400);
  }
});

contacts.put('/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'), 10);
  const body = await c.req.json().catch(() => ({}));
  const parsed = updateFixedContactSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const row = await updateFixedContact(Number(user.id), id, parsed.data);
    if (!row) return c.json({ success: false, error: '联系人不存在' }, 404);
    return c.json({ success: true, data: row });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : '更新失败' }, 400);
  }
});

contacts.delete('/:id', async (c) => {
  const user = c.get('user');
  const id = parseInt(c.req.param('id'), 10);
  const ok = await deleteFixedContact(Number(user.id), id);
  if (!ok) return c.json({ success: false, error: '联系人不存在' }, 404);
  return c.json({ success: true });
});

contacts.post('/validate', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const methods = mergeContactMethodsInput({
    emails: body.emails,
    phones: body.phones,
    telegrams: body.telegrams,
    qqs: body.qqs,
    wxpusherUids: body.wxpusherUids,
    email: body.email,
    phone: body.phone,
    telegramChatId: body.telegramChatId,
    qq: body.qq,
    wxpusherUid: body.wxpusherUid,
  });
  const result = validateContactMethods(methods);
  return c.json({ success: true, data: result });
});

// C11: 联系人分组
contacts.get('/groups', async (c) => {
  const userId = Number(c.get('user').id);
  const groups = await query('SELECT * FROM contact_groups WHERE user_id = $1 ORDER BY name', [userId]);
  const members = await query(
    `SELECT m.* FROM contact_group_members m
     JOIN contact_groups g ON g.id = m.group_id WHERE g.user_id = $1`,
    [userId],
  );
  return c.json({ success: true, data: { groups: groups.rows, members: members.rows } });
});

contacts.post('/groups', async (c) => {
  const userId = Number(c.get('user').id);
  const { name, emails } = await c.req.json().catch(() => ({}));
  if (!name) return c.json({ success: false, error: '分组名称必填' }, 400);
  const g = await query(
    'INSERT INTO contact_groups (user_id, name) VALUES ($1, $2) RETURNING *',
    [userId, String(name)],
  );
  const groupId = g.rows[0].id as number;
  if (Array.isArray(emails)) {
    for (const e of emails.slice(0, 50)) {
      await query(
        'INSERT INTO contact_group_members (group_id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [groupId, String(e)],
      );
    }
  }
  return c.json({ success: true, data: g.rows[0] }, 201);
});

// C26: vCard 生日导入
contacts.post('/import-vcard', async (c) => {
  const userId = Number(c.get('user').id);
  const text = await c.req.text();
  const blocks = text.split('BEGIN:VCARD');
  let imported = 0;
  for (const block of blocks.slice(1)) {
    const fn = block.match(/FN[^:]*:([^\r\n]+)/)?.[1]?.trim();
    const bday = block.match(/BDAY[^:]*:(\d{4}[-]?\d{2}[-]?\d{2})/)?.[1]?.replace(/-/g, '');
    const email = block.match(/EMAIL[^:]*:([^\r\n]+)/)?.[1]?.trim();
    if (!fn || !bday || bday.length < 8) continue;
    const date = `${bday.slice(0, 4)}-${bday.slice(4, 6)}-${bday.slice(6, 8)}`;
    const { createEvent } = await import('../services/event.service.js');
    await createEvent(String(userId), {
      name: `${fn} 生日`,
      type: 'birthday',
      date,
      calendarType: 'gregorian',
      personName: fn,
      reminderConfig: { enabled: true, daysBeforeList: [0, 1, 3, 7], emailRecipients: email ? [email] : [], channels: [], accountIds: [] },
    });
    imported++;
  }
  return c.json({ success: true, data: { imported } });
});

/**
 * v2.27 遗留4：联系人生日 CSV 批量导入。
 *
 * 表头行必须（列名不区分大小写/中英皆可）：姓名/name（必填）、生日/birth_date/
 * birthday（必填，YYYY-MM-DD 或 YYYY/MM/DD）、邮箱/email（可选）、电话/phone（可选）。
 * 每行：建联系人 + 复用 vCard 同款生日事件（提醒 d0/1/3/7）；同名联系人视为重复跳过。
 * 与 events import-csv 一致的手写解析（无 CSV 依赖库）；支持双引号包裹值。
 */
contacts.post('/import-csv', async (c) => {
  const userId = Number(c.get('user').id);
  const text = await c.req.text();
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) {
    return c.json({ success: false, error: 'CSV 至少需要表头行和一行数据' }, 400);
  }

  // 支持 "带,逗号" 的双引号字段：逐行状态机切分，避免砍掉第三方依赖也要解析正确。
  const splitCsvLine = (line: string): string[] => {
    const out: string[] = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  };

  const normalizeKey = (k: string) => k.toLowerCase().replace(/[\s_]/g, '');
  const headers = splitCsvLine(lines[0]).map(normalizeKey);
  const col = (...names: string[]): number => {
    for (const n of names) {
      const idx = headers.indexOf(normalizeKey(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };
  const nameIdx = col('姓名', 'name', '名字');
  const birthIdx = col('生日', 'birthday', 'birthdate', 'birth_date', 'birth', 'date');
  const emailIdx = col('邮箱', 'email', 'mail');
  const phoneIdx = col('电话', 'phone', 'mobile', '手机');
  if (nameIdx < 0 || birthIdx < 0) {
    return c.json({ success: false, error: 'CSV 表头必须包含 姓名/name 与 生日/birth_date 列' }, 400);
  }

  const parseDate = (raw: string): string | null => {
    const m = raw.match(/(\d{4})[-/年.](\d{1,2})[-/月.](\d{1,2})/);
    if (!m) return null;
    const date = `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    return Number.isNaN(new Date(date).getTime()) ? null : date;
  };

  let imported = 0;
  let skippedDuplicates = 0;
  const errors: string[] = [];

  for (let i = 1; i < lines.length; i++) {
    try {
      const values = splitCsvLine(lines[i]);
      const name = (values[nameIdx] || '').replace(/^"|"$/g, '').trim();
      const date = parseDate((values[birthIdx] || '').replace(/^"|"$/g, ''));
      if (!name || !date) {
        errors.push(`第 ${i + 1} 行：缺少姓名或生日格式无效`);
        continue;
      }
      const email = emailIdx >= 0 ? (values[emailIdx] || '').trim() : '';
      const phone = phoneIdx >= 0 ? (values[phoneIdx] || '').trim() : '';

      // 同名去重：同用户同名联系人跳过（与数据健康 duplicate_contacts 同口径）。
      const existing = await query(
        `SELECT id FROM fixed_contacts WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
        [userId, name],
      );
      if (existing.rows.length > 0) {
        skippedDuplicates++;
        continue;
      }

      const { createFixedContact } = await import('../services/contact.service.js');
      await createFixedContact(userId, {
        name,
        email: email || undefined,
        phone: phone || undefined,
        birthDate: date,
        emails: email ? [{ label: '', value: email }] : [],
        phones: phone ? [{ label: '', value: phone }] : [],
        telegrams: [],
        qqs: [],
        wxpusherUids: [],
        channelAccountIds: [],
        gender: 'unknown',
      });
      const { createEvent } = await import('../services/event.service.js');
      await createEvent(String(userId), {
        name: `${name} 生日`,
        type: 'birthday',
        date,
        calendarType: 'gregorian',
        personName: name,
        reminderConfig: { enabled: true, daysBeforeList: [0, 1, 3, 7], emailRecipients: email ? [email] : [], channels: [], accountIds: [] },
      });
      imported++;
    } catch (rowError) {
      errors.push(`第 ${i + 1} 行：${rowError instanceof Error ? rowError.message : String(rowError)}`);
    }
  }

  return c.json({ success: true, data: { imported, skippedDuplicates, errors } });
});

contacts.post('/:id/send-email', async (c) => {
  const user = c.get('user');
  const userId = Number(user.id);
  const id = parseInt(c.req.param('id'), 10);
  if (!Number.isFinite(id)) {
    return c.json({ success: false, error: '无效的联系人 ID' }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const parsed = contactSendEmailSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: 'Validation failed', details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const result = await sendContactEmail(userId, id, parsed.data);
    return c.json({ success: true, data: result });
  } catch (e) {
    return c.json({ success: false, error: e instanceof Error ? e.message : '发送失败' }, 400);
  }
});

// ---------------------------------------------------------------------------
// D4 个人 CRM：联系节奏 + 互动时间线（todo 61）
// 分页形状与 /api/expiry 一致；他人的联系人一律 404（不区分不存在，防存在性泄露）。
// ---------------------------------------------------------------------------

contacts.get('/due', async (c) => {
  const userId = Number(c.get('user').id);
  const data = await listDueContacts(userId);
  return c.json({ success: true, data });
});

contacts.get('/:id/timeline', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseContactId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的联系人 ID' }, 400);

  const page = parsePage(c.req.query('page'));
  const limit = parseLimit(c.req.query('limit'));
  const result = await listContactTimeline(userId, id, page, limit);
  if (!result) return c.json({ success: false, error: '联系人不存在' }, 404);

  return c.json({
    success: true,
    data: result.items,
    pagination: {
      page,
      limit,
      total: result.total,
      totalPages: Math.ceil(result.total / limit),
    },
  });
});

contacts.post('/:id/interactions', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseContactId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的联系人 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = createInteractionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }
  if (parsed.data.occurredAt) {
    const at = Date.parse(parsed.data.occurredAt);
    if (Number.isFinite(at) && at > Date.now() + FUTURE_TOLERANCE_MS) {
      return c.json({ success: false, error: '互动时间不能晚于当前时间' }, 400);
    }
  }

  const row = await createInteraction(userId, id, parsed.data);
  if (!row) return c.json({ success: false, error: '联系人不存在' }, 404);
  return c.json({ success: true, data: row }, 201);
});

contacts.post('/:id/promises', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseContactId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的联系人 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = createContactPromiseSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const row = await createContactPromise(userId, id, parsed.data);
  if (!row) return c.json({ success: false, error: '联系人不存在' }, 404);
  return c.json({ success: true, data: row }, 201);
});

contacts.post('/:id/gifts', async (c) => {
  const userId = Number(c.get('user').id);
  const id = parseContactId(c.req.param('id'));
  if (id === null) return c.json({ success: false, error: '无效的联系人 ID' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const parsed = createGiftRecordSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({
      success: false,
      error: formatZodError(parsed.error),
      details: z.flattenError(parsed.error),
    }, 400);
  }

  const row = await createGiftRecord(userId, id, parsed.data);
  if (!row) return c.json({ success: false, error: '联系人不存在' }, 404);
  return c.json({ success: true, data: row }, 201);
});

export default contacts;
