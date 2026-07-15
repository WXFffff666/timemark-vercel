export async function startAuth() {
  return { qrcode: '', sessionId: '' };
}

export async function checkAuth() {
  return { authenticated: false };
}

export async function logout() {}

export async function sendNotification() {
  return { success: false, message: 'IM channels are not available on Vercel serverless' };
}

export function getConnectionStatus() {
  return { connected: false, status: 'unavailable' };
}
