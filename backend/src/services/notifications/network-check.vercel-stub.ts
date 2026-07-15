export async function checkChannel() {
  return { available: false, latencyMs: null as number | null };
}

export async function checkAllChannels() {
  return [] as Array<{ channel: string; available: boolean; latencyMs: number | null }>;
}
