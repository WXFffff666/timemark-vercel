import { startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { api } from './api';

export function isPasskeySupported(): boolean {
  return typeof window !== 'undefined' && browserSupportsWebAuthn();
}

export async function registerPasskey(deviceName?: string) {
  const options = await api.post<PublicKeyCredentialCreationOptionsJSON>(
    '/auth/webauthn/register/options',
    { deviceName },
  );
  const attestation = await startRegistration({ optionsJSON: options });
  await api.post('/auth/webauthn/register/verify', {
    response: attestation,
    deviceName,
  });
}

export interface PasskeyCredential {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export async function listPasskeys(): Promise<PasskeyCredential[]> {
  const data = await api.get<PasskeyCredential[]>('/auth/webauthn/credentials');
  return Array.isArray(data) ? data : [];
}

export async function removePasskey(id: string) {
  await api.delete(`/auth/webauthn/credentials/${id}`);
}
