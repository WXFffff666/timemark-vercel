/** No-op scheduler for Vercel API bundle (real scheduler omitted in serverless deploy). */
export async function startScheduler(): Promise<void> {}

export async function stopScheduler(): Promise<void> {}

export function getSchedulerStatus(): { available: false; reason: string } {
  return { available: false, reason: 'Scheduler not bundled for Vercel' }
}
