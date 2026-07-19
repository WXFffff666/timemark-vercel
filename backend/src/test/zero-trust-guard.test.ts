import { describe, it, expect } from 'vitest';
import {
  isBlockedUserAgent,
  isProbePath,
  matchesBypassPrefix,
  shouldBypassZeroTrust,
} from '../middleware/zero-trust-guard.js';

describe('zero-trust-guard', () => {
  it('blocks known AI crawlers', () => {
    expect(isBlockedUserAgent('Mozilla/5.0 GPTBot/1.0')).toBe(true);
    expect(isBlockedUserAgent('ClaudeBot/1.0')).toBe(true);
    expect(isBlockedUserAgent('Bytespider')).toBe(true);
  });

  it('blocks security scanners', () => {
    expect(isBlockedUserAgent('sqlmap/1.0')).toBe(true);
    expect(isBlockedUserAgent('Nikto/2.1.5')).toBe(true);
  });

  it('allows normal browsers', () => {
    expect(isBlockedUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0')).toBe(false);
    expect(isBlockedUserAgent(undefined)).toBe(false);
  });

  it('detects probe paths', () => {
    expect(isProbePath('/.env')).toBe(true);
    expect(isProbePath('/api/../../.env')).toBe(true);
    expect(isProbePath('/wp-admin/setup-config.php')).toBe(true);
    expect(isProbePath('/api/events')).toBe(false);
  });

  it('bypasses cron and webhook routes', () => {
    expect(matchesBypassPrefix('/api/cron/reminder-check')).toBe(true);
    expect(matchesBypassPrefix('/api/webhook/receive/abc')).toBe(true);
    expect(matchesBypassPrefix('/api/inbox/receive/token123')).toBe(true);
    expect(matchesBypassPrefix('/api/calendar/feed/secret.ics')).toBe(true);
  });

  it('bypasses when API key present', () => {
    expect(
      shouldBypassZeroTrust({
        path: '/api/events',
        apiKey: 'x'.repeat(32),
      }),
    ).toBe(true);
  });
});
