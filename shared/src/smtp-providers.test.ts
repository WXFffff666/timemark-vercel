import { describe, expect, it } from 'vitest';
import {
  applySmtpProviderToForm,
  inferSmtpProviderId,
  parseSmtpSessionData,
} from './smtp-providers.js';
import { inferSmtpEncryption } from './smtp-transport.js';

describe('smtp-providers', () => {
  it('infers qq preset from host and port', () => {
    expect(inferSmtpProviderId('smtp.qq.com', 465)).toBe('qq');
    expect(inferSmtpProviderId('smtp.gmail.com', 587)).toBe('gmail');
    expect(inferSmtpProviderId('unknown.example.com', 587)).toBeNull();
  });

  it('applies preset host and port to form', () => {
    const next = applySmtpProviderToForm('qq', { name: 'QQ邮箱', smtpEncryption: 'ssl' });
    expect(next.webhook).toBe('smtp.qq.com');
    expect(next.secret).toBe('465');
    expect(next.smtpProvider).toBe('qq');
  });

  it('applies starttls port when selected', () => {
    const next = applySmtpProviderToForm('163', { name: '163', smtpEncryption: 'starttls' });
    expect(next.secret).toBe('587');
  });

  it('parses smtpProvider from session data', () => {
    expect(parseSmtpSessionData({ smtpProvider: '163', smtpEncryption: 'ssl' })).toEqual({
      smtpProvider: '163',
      smtpEncryption: 'ssl',
    });
  });

  it('infers encryption from port', () => {
    expect(inferSmtpEncryption(465)).toBe('ssl');
    expect(inferSmtpEncryption(587)).toBe('starttls');
  });
});
