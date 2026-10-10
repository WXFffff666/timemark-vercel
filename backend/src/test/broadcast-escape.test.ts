import { describe, expect, it, vi } from 'vitest';

/**
 * v2.31 R1（安全审计 S3）：外发广播邮件的联系人名必须转义后进入 HTML 正文。
 * 联系人名可经 ICS 导入/外部 feed 进入库——存储型注入面。
 * subject 是纯文本邮件头，不转义（nodemailer 拦 CRLF）。
 */

vi.mock('../db/index.js', () => ({ query: vi.fn() }));

import { personalizeBroadcast } from '../services/broadcast.service.js';

describe('personalizeBroadcast contact-name escaping', () => {
  it('escapes HTML-significant characters in the HTML body', () => {
    const result = personalizeBroadcast(
      '你好 {{contact_name}}',
      '<p>亲爱的 {{contact_name}}，请查收。</p>',
      { email: 'a@b.c', name: '张三 <script>alert(1)</script> &朋友' },
    );
    expect(result.html).not.toContain('<script>');
    expect(result.html).toContain('&lt;script&gt;');
    expect(result.html).toContain('&amp;朋友');
  });

  it('keeps the subject plain-text (no HTML escaping in the header)', () => {
    const result = personalizeBroadcast(
      '给 {{contact_name}} 的提醒',
      '<p>{{contact_name}}</p>',
      { email: 'a@b.c', name: '张三 & 李四' },
    );
    expect(result.subject).toContain('张三 & 李四');
    expect(result.subject).not.toContain('&amp;');
  });

  it('falls back to 你好 for a blank name (existing behavior intact)', () => {
    const result = personalizeBroadcast('hi {{contact_name}}', '<p>{{contact_name}}</p>', { email: 'a@b.c', name: '  ' });
    expect(result.html).toContain('你好');
  });
});
