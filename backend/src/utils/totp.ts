import { authenticator } from 'otplib';
import QRCode from 'qrcode';

export function generateTOTPSecret(): string {
  return authenticator.generateSecret();
}

export async function generateQRCode(secret: string, label: string): Promise<string> {
  const otpauth = authenticator.keyuri(label, 'Countdown Reminder', secret);
  return QRCode.toDataURL(otpauth);
}

export function verifyTOTP(secret: string, token: string): boolean {
  return authenticator.verify({ token, secret });
}
