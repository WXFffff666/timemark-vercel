export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export function buildSmtpTransportOptions(
  host: string,
  port: number,
  fromEmail: string,
  password: string,
): SmtpTransportOptions {
  const resolvedPort = port || 587;
  return {
    host,
    port: resolvedPort,
    secure: resolvedPort === 465,
    requireTLS: resolvedPort === 587,
    auth: {
      user: fromEmail,
      pass: password,
    },
  };
}
