/**
 * Channels supported on Vercel / cloud serverless (HTTP API only).
 * Plugin channels (WeChat/WhatsApp/QQ QR login, Signal CLI, etc.) are excluded.
 */

export const UNSUPPORTED_CHANNEL_IDS = new Set([
  // Plugin / QR / local process — not available on serverless
  'wechat_personal',
  'whatsapp',
  'qq_bot',
  'signal',
  'imessage',
  'zalo',
  'clawbot',
  // Long-lived relay connections
  'nostr',
]);

export function isSupportedChannel(channelId: string): boolean {
  return !UNSUPPORTED_CHANNEL_IDS.has(channelId);
}

export function filterSupportedChannels(channelIds: string[]): string[] {
  return channelIds.filter(isSupportedChannel);
}
