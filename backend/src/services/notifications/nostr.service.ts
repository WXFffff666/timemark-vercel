/**
 * Nostr 协议通知服务
 * https://github.com/nostr-protocol/nostr
 * 
 * 使用 nostr-tools 发送加密私信 (NIP-04 kind:4)
 */
import { getBlessing } from '../../../../shared/src/blessings.js';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { encrypt } from 'nostr-tools/nip04';
import { Relay } from 'nostr-tools/relay';
import { hexToBytes } from 'nostr-tools/utils';

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.nostr.band',
];

export async function sendNostrNotification(
  event: any,
  privateKeyHex: string,
  targetPubkey: string,
  relayUrl?: string
): Promise<void> {
  const blessing = getBlessing(
    event.type,
    event.reminderConfig?.customMessage,
    event.personName,
    event.reminderRecipientName
  );
  const message = event.customMessage || `📅 ${event.name}\n📆 日期: ${event.date}\n🏷️ 类型: ${event.type}\n\n🎉 ${blessing}`;

  // Convert hex private key to Uint8Array
  const sk = hexToBytes(privateKeyHex);

  // Encrypt message using NIP-04
  const ciphertext = await encrypt(sk, targetPubkey, message);

  // Create kind:4 encrypted DM event
  const nostrEvent = finalizeEvent({
    kind: 4,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', targetPubkey]],
    content: ciphertext,
  }, sk);

  // Publish to relay(s)
  const relays = relayUrl ? [relayUrl] : DEFAULT_RELAYS;
  let published = false;
  for (const url of relays) {
    try {
      const relay = await Relay.connect(url);
      try {
        await relay.publish(nostrEvent);
        published = true;
        break;
      } finally {
        relay.close();
      }
    } catch (e) {
      console.error(`[Nostr] Failed to publish to ${url}:`, e);
    }
  }

  if (!published) {
    throw new Error('Failed to publish to any Nostr relay');
  }
}
