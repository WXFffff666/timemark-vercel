/**
 * todo 88 — client-side Open Graph / Twitter card injection for the share and embed pages.
 *
 * The Vite SPA is served as a static `index.html` shell (vercel.json rewrites every non-API path
 * to /index.html); these tags are therefore injected at runtime for JS-capable agents. The
 * server-side counterpart lives in `backend/src/routes/og.ts` (a crawler-readable response and a
 * deterministic SVG image at `/api/og/image/:token`).
 */

export const EVENT_TYPE_LABELS: Record<string, string> = {
  birthday: '生日',
  exam: '考试',
  anniversary: '纪念日',
  holiday: '节日',
  meeting: '会议',
  deadline: '截止日期',
  travel: '旅行',
  graduation: '毕业',
  wedding: '婚礼',
  medical: '医疗',
  other: '重要日子',
};

export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABELS[type] ?? EVENT_TYPE_LABELS.other;
}

/** Day-granularity countdown phrase shared with the backend renderer. */
export function formatCountdownDays(days: number | null | undefined): string {
  if (days == null || !Number.isFinite(days)) return '重要日子';
  if (days === 0) return '就是今天';
  if (days > 0) return `还有 ${days} 天`;
  return `已过去 ${Math.abs(days)} 天`;
}

export interface EventOgData {
  name: string;
  description: string;
  imageUrl: string;
  url?: string;
}

const MANAGED: ReadonlyArray<{ attr: 'property' | 'name'; key: string }> = [
  { attr: 'property', key: 'og:type' },
  { attr: 'property', key: 'og:site_name' },
  { attr: 'property', key: 'og:title' },
  { attr: 'property', key: 'og:description' },
  { attr: 'property', key: 'og:image' },
  { attr: 'property', key: 'og:url' },
  { attr: 'name', key: 'twitter:card' },
  { attr: 'name', key: 'twitter:title' },
  { attr: 'name', key: 'twitter:description' },
  { attr: 'name', key: 'twitter:image' },
];

function upsert(doc: Document, attr: 'property' | 'name', key: string, content: string): void {
  const existing = doc.head.querySelector<HTMLMetaElement>(`meta[${attr}="${key}"]`);
  const el = existing ?? doc.createElement('meta');
  if (!existing) {
    el.setAttribute(attr, key);
    doc.head.appendChild(el);
  }
  el.setAttribute('content', content);
}

export function applyEventOgMeta(data: EventOgData, doc: Document = document): void {
  const title = `${data.name} · TimeMark`;
  upsert(doc, 'property', 'og:type', 'website');
  upsert(doc, 'property', 'og:site_name', 'TimeMark');
  upsert(doc, 'property', 'og:title', title);
  upsert(doc, 'property', 'og:description', data.description);
  upsert(doc, 'property', 'og:image', data.imageUrl);
  if (data.url) upsert(doc, 'property', 'og:url', data.url);
  upsert(doc, 'name', 'twitter:card', 'summary_large_image');
  upsert(doc, 'name', 'twitter:title', title);
  upsert(doc, 'name', 'twitter:description', data.description);
  upsert(doc, 'name', 'twitter:image', data.imageUrl);
}

export function clearEventOgMeta(doc: Document = document): void {
  for (const { attr, key } of MANAGED) {
    doc.head.querySelectorAll(`meta[${attr}="${key}"]`).forEach((el) => el.remove());
  }
}
