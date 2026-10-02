import { describe, it, expect } from 'vitest';
import { maskCredentialInUrl } from './credentials';

/**
 * 回归证明：这些集成 URL 的最后一段路径就是凭证，拿到 URL 就等于拿到凭证
 * （后端不校验登录态，只比对路径里的 token）。设置页以前明文显示，旁观 / 截屏 /
 * 录屏都会泄露，所以显示时必须遮罩令牌段。
 */
describe('maskCredentialInUrl', () => {
  it('masks the token segment of an inbox receive URL', () => {
    expect(maskCredentialInUrl('https://timemark.example.com/api/inbox/receive/abc123secret')).toBe(
      'https://timemark.example.com/api/inbox/receive/' + '•'.repeat(8),
    );
  });

  it('never lets the secret itself survive in the output', () => {
    const secret = 'sk_live_51H8xQ2eZvKYlo2C';
    const masked = maskCredentialInUrl(`https://example.com/api/webhook/receive/${secret}`);
    expect(masked).not.toContain(secret);
    expect(masked).not.toContain('sk_live');
  });

  it('keeps the origin visible so the user can still tell where it points', () => {
    const masked = maskCredentialInUrl('https://example.com/api/webhook/receive/tok');
    expect(masked.startsWith('https://example.com/api/webhook/receive/')).toBe(true);
  });

  it('keeps the .ics suffix, which subscribers require and which is not secret', () => {
    expect(maskCredentialInUrl('https://example.com/api/calendar/feed/tok123.ics')).toBe(
      'https://example.com/api/calendar/feed/' + '•'.repeat(8) + '.ics',
    );
  });

  it('does not mask a query-string credential away', () => {
    // 令牌在 query 里时最后一段就是整个 query，同样要遮罩
    expect(maskCredentialInUrl('https://example.com/feed?token=abc123')).not.toContain('abc123');
  });

  it('masks every distinct secret to the same width so length does not leak it', () => {
    expect(maskCredentialInUrl('https://e.com/a/short')).toBe(
      maskCredentialInUrl('https://e.com/a/a-much-longer-token-value'),
    );
  });

  it('degrades to a fixed mask instead of throwing on a slash-less value', () => {
    expect(maskCredentialInUrl('opaque-token')).toBe('•'.repeat(8));
  });
});