import { z } from 'zod';

export const createNotificationAccountSchema = z.object({
  type: z.string().min(1, 'Type is required'),
  name: z.string().min(1, 'Name is required').max(100),
  webhook: z.string().url().optional().nullable(),
  token: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  chatId: z.string().optional().nullable(),
  configMethod: z.enum(['webhook', 'token', 'plugin']).optional().default('webhook'),
  sessionData: z.any().optional().nullable(),
  pluginPackage: z.string().optional().nullable(),
});

export const updateNotificationAccountSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  webhook: z.string().url().optional().nullable(),
  token: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  chatId: z.string().optional().nullable(),
  isActive: z.boolean().optional(),
  configMethod: z.enum(['webhook', 'token', 'plugin']).optional(),
  sessionData: z.any().optional().nullable(),
  pluginPackage: z.string().optional().nullable(),
});

export const saveUserConfigSchema = z.object({
  resend_api_key: z.string().optional().nullable(),
  github_token: z.string().optional().nullable(),
  feishu_webhook: z.string().url().optional().nullable(),
  wecom_webhook: z.string().url().optional().nullable(),
  dingtalk_webhook: z.string().url().optional().nullable(),
  dingtalk_secret: z.string().optional().nullable(),
  telegram_bot_token: z.string().optional().nullable(),
  discord_webhook: z.string().url().optional().nullable(),
  slack_webhook: z.string().url().optional().nullable(),
  wxpusher_app_token: z.string().optional().nullable(),
  wxpusher_uid: z.string().optional().nullable(),
  qmsg_key: z.string().optional().nullable(),
  qmsg_qq: z.string().optional().nullable(),
  reminder_emails: z.array(z.string().email()).optional(),
  alert_channels: z.array(z.string()).optional(),
});

export const testConnectionSchema = z.object({
  type: z.string().min(1),
  configMethod: z.enum(['webhook', 'token', 'plugin']).optional().default('webhook'),
  webhook: z.string().optional().nullable(),
  token: z.string().optional().nullable(),
  chatId: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  sessionData: z.any().optional().nullable(),
});
