import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyEventOgMeta,
  clearEventOgMeta,
  eventTypeLabel,
  formatCountdownDays,
} from './og-meta';

function metaContent(attr: 'property' | 'name', key: string): string | null {
  return document.head.querySelector(`meta[${attr}="${key}"]`)?.getAttribute('content') ?? null;
}

describe('og-meta', () => {
  beforeEach(() => {
    clearEventOgMeta();
    document.head.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]').forEach((el) => el.remove());
  });

  it('injects event-specific OG + Twitter tags', () => {
    applyEventOgMeta({
      name: '妈妈的生日',
      description: '还有 5 天 · 生日',
      imageUrl: 'https://x.test/api/og/image/tok',
      url: 'https://x.test/share/tok',
    });

    expect(metaContent('property', 'og:title')).toBe('妈妈的生日 · TimeMark');
    expect(metaContent('property', 'og:description')).toBe('还有 5 天 · 生日');
    expect(metaContent('property', 'og:image')).toBe('https://x.test/api/og/image/tok');
    expect(metaContent('property', 'og:url')).toBe('https://x.test/share/tok');
    expect(metaContent('name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent('name', 'twitter:title')).toBe('妈妈的生日 · TimeMark');
    expect(metaContent('name', 'twitter:image')).toBe('https://x.test/api/og/image/tok');
  });

  it('updates a pre-existing tag instead of duplicating it', () => {
    const existing = document.createElement('meta');
    existing.setAttribute('property', 'og:title');
    existing.setAttribute('content', 'TimeMark');
    document.head.appendChild(existing);

    applyEventOgMeta({ name: 'A', description: 'd', imageUrl: 'i' });

    expect(document.head.querySelectorAll('meta[property="og:title"]')).toHaveLength(1);
    expect(metaContent('property', 'og:title')).toBe('A · TimeMark');
  });

  it('clearEventOgMeta removes every managed tag', () => {
    applyEventOgMeta({ name: 'A', description: 'd', imageUrl: 'i', url: 'u' });
    clearEventOgMeta();
    expect(document.head.querySelector('meta[property="og:title"]')).toBeNull();
    expect(document.head.querySelector('meta[name="twitter:card"]')).toBeNull();
    expect(document.head.querySelector('meta[property="og:url"]')).toBeNull();
  });

  it('labels unknown types generically and formats the countdown', () => {
    expect(eventTypeLabel('birthday')).toBe('生日');
    expect(eventTypeLabel('deadline')).toBe('截止日期');
    expect(eventTypeLabel('mystery')).toBe('重要日子');
    expect(formatCountdownDays(0)).toBe('就是今天');
    expect(formatCountdownDays(5)).toBe('还有 5 天');
    expect(formatCountdownDays(-2)).toBe('已过去 2 天');
    expect(formatCountdownDays(null)).toBe('重要日子');
  });
});
