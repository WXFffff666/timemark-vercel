export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
  auth: {
    user: string;
    pass: string;
  };
  connectionTimeout?: number;
  greetingTimeout?: number;
  socketTimeout?: number;
  tls?: {
    minVersion?: 'TLSv1.2' | 'TLSv1.3';
  };
}

const SMTP_TIMEOUT_MS = 30_000;

export function buildSmtpTransportOptions(
  host: string,
  port: number,
  fromEmail: string,
  password: string,
): SmtpTransportOptions {
  const resolvedPort = Number(port) || 587;
  const useSsl = resolvedPort === 465;
  // SMTP_REQUIRE_TLS=false 供内网无 TLS 的 relay / 本地 MailHog 类服务器使用；
  // 默认保持强制 STARTTLS（公网 587 端口的正确姿态）。
  const requireTls = process.env.SMTP_REQUIRE_TLS !== 'false';
  return {
    host: host.trim(),
    port: resolvedPort,
    secure: useSsl,
    ...(useSsl || !requireTls ? {} : { requireTLS: true }),
    auth: {
      user: fromEmail.trim(),
      pass: password,
    },
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
    tls: {
      minVersion: 'TLSv1.2',
    },
  };
}

export function resolveSmtpPort(encryption: 'ssl' | 'starttls' | string | undefined): number {
  return encryption === 'starttls' ? 587 : 465;
}

export function inferSmtpEncryption(port?: string | number | null): 'ssl' | 'starttls' {
  return String(port ?? '465') === '587' ? 'starttls' : 'ssl';
}
