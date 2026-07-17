import { inferSmtpProviderId, parseSmtpSessionData } from '@timemark/shared';

/** API 响应中敏感字段占位，前端留空表示不修改 */
export const CREDENTIAL_PLACEHOLDER = '';

export function maskCredentialValue(value?: string | null): string | null {
  if (!value) return null;
  return null;
}

function resolveSmtpProviderForClient(account: Record<string, unknown>): string | null {
  if (account.type !== 'smtp') return null;
  const fromSession = parseSmtpSessionData(account.session_data).smtpProvider;
  if (fromSession) return fromSession;
  const inferred = inferSmtpProviderId(
    typeof account.webhook === 'string' ? account.webhook : null,
    typeof account.secret === 'string' || typeof account.secret === 'number' ? account.secret : null,
  );
  return inferred || 'custom';
}

export function maskNotificationAccountForClient<T extends Record<string, unknown>>(account: T): T & {
  tokenConfigured: boolean;
  secretConfigured: boolean;
  sessionConfigured: boolean;
  smtpProvider?: string | null;
} {
  const tokenConfigured = !!account.token;
  const secretConfigured = !!account.secret;
  const sessionConfigured = !!account.session_data;
  const smtpProvider = resolveSmtpProviderForClient(account);
  return {
    ...account,
    token: tokenConfigured ? null : account.token,
    secret: secretConfigured ? null : account.secret,
    session_data: sessionConfigured ? null : account.session_data,
    smtpProvider,
    tokenConfigured,
    secretConfigured,
    sessionConfigured,
  } as T & {
    tokenConfigured: boolean;
    secretConfigured: boolean;
    sessionConfigured: boolean;
    smtpProvider?: string | null;
  };
}
