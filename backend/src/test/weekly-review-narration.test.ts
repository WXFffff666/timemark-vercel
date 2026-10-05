import { describe, expect, it } from 'vitest';
import type { AgentJobHandlerContext } from '../services/agent/job-runner.service.js';
import type { AgentJobKind, ClaimedJob } from '../services/agent/queue.service.js';
import {
  createWeeklyReviewHandler,
  type WeeklyReviewSummary,
} from '../services/agent/routines/weekly-review.js';
import type { TriageCandidate } from '../services/agent/routines/hourly-triage.js';

/**
 * v2.26 E：周报 AI 综述（第一个真实 AI 消费者）的行为证明。
 *
 * 全部依赖注入、不碰数据库也不碰真网关：
 * - AI 未配置（narrate → null）：narrative 为 null，markdown 与纯确定性渲染逐字节一致；
 * - AI 成功：综述置顶（`> 🤖` 引用行），narrativeSource = 'ai'，costTokens 计入 usage；
 * - 空清单：narrate 根本不该被调用（省钱）。
 */

let jobSeq = 0;
function claimedJob(kind: AgentJobKind): ClaimedJob {
  jobSeq += 1;
  const n = String(jobSeq).padStart(12, '0');
  return {
    id: `00000000-0000-4000-8000-${n}`,
    userId: 1,
    kind,
    payload: {},
    priority: 0,
    attempt: 1,
    maxAttempts: 3,
    leaseToken: `10000000-0000-4000-8000-${n}`,
    leaseExpiresAt: '2026-01-15T01:00:00.000Z',
  };
}

const context: AgentJobHandlerContext = { tier: 'medium' } as unknown as AgentJobHandlerContext;

function candidate(over: Partial<TriageCandidate> = {}): TriageCandidate {
  return {
    fingerprint: 'event:1',
    title: '妈妈生日',
    eventType: 'birthday',
    band: 'high',
    importance: 80,
    sourceKind: 'event',
    sourceRef: '1',
    daysUntil: 3,
    ...over,
  };
}

function makeDeps(candidates: TriageCandidate[], narrate?: Parameters<typeof createWeeklyReviewHandler>[0]) {
  const base = {
    now: () => new Date('2026-01-15T01:00:00.000Z'),
    loadState: async () => [],
    loadCandidates: async () => candidates,
    saveState: async () => 0,
    markIncluded: async () => 0,
    ...narrate,
  };
  return base;
}

describe('weekly-review AI narration', () => {
  it('falls back to the pure deterministic digest when AI is unavailable', async () => {
    const handler = createWeeklyReviewHandler(
      makeDeps([candidate()], { narrate: async () => null }) as never,
    );
    const { result, costTokens } = (await handler(claimedJob('weekly_review'), context)) as {
      result: WeeklyReviewSummary;
      costTokens: number;
    };

    expect(result.narrative).toBeNull();
    expect(result.narrativeSource).toBe('deterministic');
    expect(result.markdown).not.toContain('🤖');
    expect(result.markdown).toContain('妈妈生日');
    expect(costTokens).toBe(0);
  });

  it('prepends the AI narrative as a quote line and counts usage tokens', async () => {
    const handler = createWeeklyReviewHandler(
      makeDeps([candidate()], {
        narrate: async () => ({ narrative: '最近三件事里生日最近，建议本周末先准备礼物。', totalTokens: 137 }),
      }) as never,
    );
    const { result, costTokens } = (await handler(claimedJob('weekly_review'), context)) as {
      result: WeeklyReviewSummary;
      costTokens: number;
    };

    expect(result.narrativeSource).toBe('ai');
    expect(result.markdown.startsWith('> 🤖 最近三件事里生日最近')).toBe(true);
    expect(result.markdown).toContain('# 📋 每周回顾');
    expect(costTokens).toBe(137);
  });

  it('does not call narrate for an empty digest (spend-free week)', async () => {
    let narrateCalls = 0;
    const handler = createWeeklyReviewHandler(
      makeDeps([], {
        narrate: async () => {
          narrateCalls += 1;
          return null;
        },
      }) as never,
    );
    const { result } = (await handler(claimedJob('weekly_review'), context)) as {
      result: WeeklyReviewSummary;
    };

    expect(narrateCalls).toBe(0);
    expect(result.narrative).toBeNull();
    expect(result.markdown).toContain('本周没有达到重要性门槛的新事项');
  });
});
