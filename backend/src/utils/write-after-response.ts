import { waitUntil } from '@vercel/functions';
import { createLogger } from './logger.js';

/**
 * Checkbox 116: the bounded, best-effort slot for work that may run AFTER the
 * HTTP response has been sent.
 *
 * CONTRACT — read before using:
 *  - BEST-EFFORT ONLY. The task is raced against {@link WRITE_AFTER_RESPONSE_BUDGET_MS};
 *    when the budget expires this helper stops waiting and logs. A timed-out task
 *    is not retried and the request never blocks on it.
 *  - NON-DURABLE ONLY. If the work writes state that must survive the response
 *    (a row a later request or replay depends on), it MUST be enqueued instead —
 *    `enqueue()` from services/agent/queue.service.ts — so it survives instance
 *    recycling, crashes and retries. Passing `mutatesDurableState: true` throws
 *    {@link DurableTaskRequiredError} and logs: a loud refusal, never a silent drop.
 *  - IDEMPOTENT ONLY. Everything on this platform is at-least-once; callers must
 *    still make the task safe to run twice.
 *  - NEVER REJECTS. Every task error and every timeout is caught and logged, so
 *    nothing here can surface as an unhandled rejection.
 *
 * `waitUntil` (from @vercel/functions) is what lets the Vercel Function finish
 * background work after the response; the budget is a local timer and the promise
 * chain is fully handled, so a slow or failing task can neither hold the response
 * open nor crash the process. The `@vercel/functions` import is intentionally the
 * only platform coupling — under local Node it is a safe passthrough.
 */

/** Hard cap on how long a post-response task may run before we stop waiting. */
export const WRITE_AFTER_RESPONSE_BUDGET_MS = 30_000;

const log = createLogger('write-after-response');

/** Thrown (after logging) when a durable mutation is routed through the best-effort slot. */
export class DurableTaskRequiredError extends Error {
  /** The caller-supplied label of the refused task. */
  readonly label: string;

  constructor(label: string) {
    super(
      `writeAfterResponse(${label}): the task mutates durable state and must survive the response. ` +
        'Enqueue it on the agent queue instead (enqueue() from services/agent/queue.service.ts) — ' +
        'writeAfterResponse is bounded, best-effort and non-durable by contract.',
    );
    this.name = 'DurableTaskRequiredError';
    this.label = label;
  }
}

export interface WriteAfterResponseOptions {
  /** Stable, loggable task name (e.g. 'notification.outbound_webhook'). */
  label: string;
  /**
   * Must be `true` iff the task writes state that has to survive the response;
   * such tasks are refused here and must be enqueued instead.
   */
  mutatesDurableState: boolean;
}

/** Race `task` against the budget; settles with an outcome value, so it never rejects. */
async function runWithinBudget(task: () => Promise<unknown>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<'budget'>((resolve) => {
    timer = setTimeout(() => resolve('budget'), WRITE_AFTER_RESPONSE_BUDGET_MS);
  });
  const work: Promise<'done' | 'error'> = Promise.resolve()
    .then(() => task())
    .then(
      (): 'done' => 'done',
      (error: unknown): 'error' => {
        log.warn(
          { event: 'write_after_response.task_failed', label, err: error },
          `Post-response task failed (${label})`,
        );
        return 'error';
      },
    );
  try {
    const outcome = await Promise.race([work, budget]);
    if (outcome === 'budget') {
      log.warn(
        {
          event: 'write_after_response.budget_exceeded',
          label,
          budgetMs: WRITE_AFTER_RESPONSE_BUDGET_MS,
        },
        `Post-response task exceeded the ${WRITE_AFTER_RESPONSE_BUDGET_MS} ms budget (${label}); ` +
          'the task may still finish in the background',
      );
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Schedule `task` to run after the response, bounded by
 * {@link WRITE_AFTER_RESPONSE_BUDGET_MS} and never allowed to reject.
 *
 * @throws {DurableTaskRequiredError} when `options.mutatesDurableState` is true —
 *         durable work must be enqueued (see the module contract above).
 */
export function writeAfterResponse(
  task: () => Promise<unknown>,
  options: WriteAfterResponseOptions,
): void {
  if (options.mutatesDurableState) {
    const refused = new DurableTaskRequiredError(options.label);
    log.error(
      { event: 'write_after_response.durable_task_refused', label: options.label },
      refused.message,
    );
    throw refused;
  }
  const guarded = runWithinBudget(task, options.label).catch((error: unknown) => {
    // Defense in depth: runWithinBudget already swallows everything, but logging
    // failures must never turn into an unhandled rejection either.
    log.error(
      { event: 'write_after_response.unexpected_failure', label: options.label, err: error },
      'Post-response guard failed unexpectedly',
    );
  });
  waitUntil(guarded);
}
