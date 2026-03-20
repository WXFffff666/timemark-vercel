import { z } from 'zod';

export const loginSchema = z.object({
  username: z.string().min(3).max(50),
  password: z.string().min(6),
  deviceFingerprint: z.string().optional(),
  rememberMe: z.boolean().optional().default(false),
});

export const verify2FASchema = z.object({
  tempToken: z.string(),
  totpCode: z.string().length(6),
  trustDevice: z.boolean(),
  deviceFingerprint: z.string().optional(),
  rememberMe: z.boolean().optional().default(false),
});

export const setup2FASchema = z.object({
  totpCode: z.string().length(6),
});
