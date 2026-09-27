import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '@timemark/shared';
import {
  addDaysIso,
  computeNextDueAt,
  daysUntil,
  formatAmountCents,
  formatCadenceLabel,
  formatTimelineAt,
  formatYmdLocal,
  giftDirectionLabel,
  interactionKindLabel,
  isCadenceDue,
  latestInteractionAt,
  promiseStatusText,
  relationshipCategoryLabel,
  timelineEntryBody,
  timelineEntryTitle,
} from './contact-crm-utils';

function interaction(id: number, at: string, summary: string | null = null): TimelineEntry {
  return {
    type: 'interaction',
    id,
    at,
    interaction_kind: 'call',
    summary,
    mood: null,
    promise_text: null,
    due_at: null,
    done_at: null,
    gift_description: null,
    direction: null,
    occasion: null,
    amount_cents: null,
    created_at: at,
  };
}

function promise(id: number, at: string, text: string | null, due: string | null, done: string | null): TimelineEntry {
  return {
    type: 'promise',
    id,
    at,
    interaction_kind: null,
    summary: null,
    mood: null,
    promise_text: text,
    due_at: due,
    done_at: done,
    gift_description: null,
    direction: null,
    occasion: null,
    amount_cents: null,
    created_at: at,
  };
}

function gift(id: number, at: string, description: string | null, occasion: string | null, cents: string | number | null): TimelineEntry {
  return {
    type: 'gift',
    id,
    at,
    interaction_kind: null,
    summary: null,
    mood: null,
    promise_text: null,
    due_at: null,
    done_at: null,
    gift_description: description,
    direction: 'given',
    occasion,
    amount_cents: cents,
    created_at: at,
  };
}

describe('contact-crm-utils labels', () => {
  it('maps preset cadence days to friendly labels and falls back for custom values', () => {
    expect(formatCadenceLabel(7)).toBe('每周');
    expect(formatCadenceLabel(30)).toBe('每月');
    expect(formatCadenceLabel(365)).toBe('每年');
    expect(formatCadenceLabel(45)).toBe('每 45 天');
  });

  it('treats null / zero / non-finite cadence as 未设置', () => {
    expect(formatCadenceLabel(null)).toBe('未设置');
    expect(formatCadenceLabel(undefined)).toBe('未设置');
    expect(formatCadenceLabel(0)).toBe('未设置');
    expect(formatCadenceLabel(Number.NaN)).toBe('未设置');
  });

  it('labels interaction kinds, gift directions and relationship categories', () => {
    expect(interactionKindLabel('call')).toBe('电话联系');
    expect(interactionKindLabel('meal')).toBe('聚餐');
    expect(interactionKindLabel(null)).toBe('互动');
    expect(interactionKindLabel('bogus')).toBe('互动');
    expect(giftDirectionLabel('received')).toBe('收到的礼物');
    expect(giftDirectionLabel('nonsense')).toBe('礼物');
    expect(relationshipCategoryLabel('family')).toBe('家人');
    expect(relationshipCategoryLabel(null)).toBe('其他');
  });
});

describe('contact-crm-utils dates', () => {
  it('formats local dates and times deterministically', () => {
    const iso = new Date(2026, 0, 15, 9, 30).toISOString();
    expect(formatYmdLocal(iso)).toBe('2026-01-15');
    expect(formatTimelineAt(iso)).toBe('2026-01-15 09:30');
    expect(formatYmdLocal('not-a-date')).toBe('');
    expect(formatTimelineAt(null)).toBe('');
  });

  it('adds days and refuses malformed input', () => {
    const base = new Date(2026, 0, 15).toISOString();
    const plus30 = addDaysIso(base, 30);
    expect(plus30).not.toBeNull();
    expect(formatYmdLocal(plus30)).toBe('2026-02-14');
    expect(addDaysIso(null, 30)).toBeNull();
    expect(addDaysIso(base, null)).toBeNull();
    expect(addDaysIso('garbage', 30)).toBeNull();
  });

  it('computes days-until and due state against a fixed clock', () => {
    const now = new Date(2026, 5, 10, 12, 0);
    const future = new Date(2026, 5, 13, 12, 0).toISOString();
    const past = new Date(2026, 5, 9, 12, 0).toISOString();
    expect(daysUntil(future, now)).toBe(3);
    expect(daysUntil(past, now)).toBeLessThan(0);
    expect(daysUntil(null, now)).toBeNull();
    expect(isCadenceDue(past, now)).toBe(true);
    expect(isCadenceDue(future, now)).toBe(false);
    expect(isCadenceDue(null, now)).toBe(false);
  });

  it('derives next-due only when both a last-contact and a cadence exist', () => {
    const last = new Date(2026, 0, 1).toISOString();
    expect(formatYmdLocal(computeNextDueAt(last, 30))).toBe('2026-01-31');
    expect(computeNextDueAt(null, 30)).toBeNull();
    expect(computeNextDueAt(last, null)).toBeNull();
  });
});

describe('contact-crm-utils timeline', () => {
  it('picks the newest interaction and ignores promises/gifts', () => {
    const entries = [
      interaction(1, '2026-01-05T10:00:00.000Z'),
      promise(2, '2026-02-01T10:00:00.000Z', '还书', '2026-02-10', null),
      interaction(3, '2026-01-20T10:00:00.000Z'),
      gift(4, '2026-03-01T10:00:00.000Z', '书', null, null),
    ];
    expect(latestInteractionAt(entries)).toBe('2026-01-20T10:00:00.000Z');
    expect(latestInteractionAt([gift(1, '2026-01-01T00:00:00.000Z', 'x', null, null)])).toBeNull();
  });

  it('renders safe titles and bodies for every entry type', () => {
    expect(timelineEntryTitle(interaction(1, '2026-01-01T00:00:00.000Z'))).toBe('电话联系');
    expect(timelineEntryBody(interaction(1, '2026-01-01T00:00:00.000Z', null))).toBe('已记录一次互动');
    expect(timelineEntryBody(interaction(1, '2026-01-01T00:00:00.000Z', '聊了工作'))).toBe('聊了工作');

    expect(timelineEntryTitle(promise(1, '2026-01-01T00:00:00.000Z', '还书', null, null))).toBe('约定');
    expect(timelineEntryBody(promise(1, '2026-01-01T00:00:00.000Z', null, null, null))).toBe('（无内容）');
    expect(promiseStatusText(promise(1, '2026-01-01T00:00:00.000Z', '还书', '2026-02-01', null))).toBe('截止 2026-02-01');
    expect(promiseStatusText(promise(1, '2026-01-01T00:00:00.000Z', '还书', null, '2026-02-05T00:00:00.000Z'))).toContain('完成');
    expect(promiseStatusText(interaction(1, '2026-01-01T00:00:00.000Z'))).toBeNull();

    const giftEntry = gift(1, '2026-01-01T00:00:00.000Z', '围巾', '生日', '19900');
    expect(timelineEntryTitle(giftEntry)).toBe('送出的礼物');
    expect(timelineEntryBody(giftEntry)).toBe('围巾 · 生日 · ¥199.00');
    expect(timelineEntryBody(gift(1, '2026-01-01T00:00:00.000Z', null, null, null))).toBe('礼物往来');
  });

  it('formats amounts from BIGINT strings and rejects garbage', () => {
    expect(formatAmountCents('19900')).toBe('¥199.00');
    expect(formatAmountCents(0)).toBe('¥0.00');
    expect(formatAmountCents(null)).toBeNull();
    expect(formatAmountCents('')).toBeNull();
    expect(formatAmountCents('abc')).toBeNull();
  });
});
