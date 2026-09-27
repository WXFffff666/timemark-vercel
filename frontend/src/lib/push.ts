import { api } from './api';

/**
 * Browser Web Push helpers (checkbox 84).
 *
 * VAPID only — the browser never uses FCM here. The VAPID public key comes from
 * `GET /api/push/vapid-key`; when the backend has no `PUSH_VAPID_*` env
 * configured that call fails with 501 and the message is surfaced to the UI.
 */

export type WebPushState = 'unsupported' | 'denied' | 'subscribed' | 'unsubscribed';

export interface PushTestResult {
  sent: number;
  removed: number;
  failed: number;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  );
}

async function getOrRegisterServiceWorker(): Promise<ServiceWorkerRegistration> {
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return registration;
}

export async function getWebPushState(): Promise<WebPushState> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return 'unsubscribed';
  const subscription = await registration.pushManager.getSubscription();
  return subscription ? 'subscribed' : 'unsubscribed';
}

/**
 * Subscribe this browser (permission request included).
 * Returns 'unsupported'/'denied' for capability failures; throws (with the
 * backend message) when VAPID is not configured or the API rejects the request.
 */
export async function subscribeWebPush(): Promise<'granted' | 'denied' | 'unsupported'> {
  if (!isPushSupported()) return 'unsupported';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  const registration = await getOrRegisterServiceWorker();
  const { publicKey } = await api.get<{ publicKey: string }>('/push/vapid-key');

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await api.post('/push/subscribe', subscription.toJSON());
  return 'granted';
}

export async function unsubscribeWebPush(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return;

  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  await api.delete('/push/unsubscribe', { endpoint: subscription.endpoint });
  await subscription.unsubscribe();
}

export async function isWebPushSubscribed(): Promise<boolean> {
  return (await getWebPushState()) === 'subscribed';
}

/** Send a test push through the backend to every stored browser subscription. */
export function sendTestWebPush(): Promise<PushTestResult> {
  return api.post<PushTestResult>('/push/test');
}
