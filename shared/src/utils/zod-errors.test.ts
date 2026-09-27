import { describe, it, expect } from 'vitest';
import { formatZodError } from './zod-errors.js';
import { testConnectionSchema } from '../schemas/config.schema.js';
import { createFixedContactSchema } from '../schemas/contact.schema.js';
import { broadcastEmailSchema } from '../schemas/broadcast.schema.js';

/**
 * Zod 4 migration snapshot (checkbox 33).
 *
 * These exact strings were captured from the Zod 3 implementation before the upgrade
 * (`.omo/evidence/task-33-zod-before.txt`). Validation semantics and all custom
 * Chinese messages must be byte-identical after the migration.
 */
describe('formatZodError Zod-3 -> Zod-4 snapshot', () => {
  it('keeps the Chinese message for a missing test-connection accountId', () => {
    const parsed = testConnectionSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatZodError(parsed.error)).toBe('accountId: 请提供 accountId 或渠道类型 type');
    }
  });

  it('keeps the Chinese messages for an empty fixed contact', () => {
    const parsed = createFixedContactSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatZodError(parsed.error)).toBe(
        'name: 姓名不能为空；至少填写一种联系方式（邮箱/手机/Telegram/QQ/WxPusher）',
      );
    }
  });

  it('keeps the custom Chinese email message for a malformed contact email', () => {
    const parsed = createFixedContactSchema.safeParse({ name: '张三', email: 'not-an-email' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatZodError(parsed.error)).toBe('email: 邮箱格式不正确');
    }
  });

  it('keeps the Chinese messages for an empty broadcast email', () => {
    const parsed = broadcastEmailSchema.safeParse({ subject: '', html: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(formatZodError(parsed.error)).toBe('subject: 主题不能为空；html: 内容不能为空；请选择至少一个收件人');
    }
  });

  it('classifies a bad accountId under the same field path as before', () => {
    const parsed = testConnectionSchema.safeParse({ accountId: 'abc' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const flat = formatZodError(parsed.error);
      expect(flat.startsWith('accountId: ')).toBe(true);
    }
  });
});
