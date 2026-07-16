import { z } from 'zod';

export const createNotificationAccountSchema = z.object({
  type: z.string().min(1, 'Type is required'),
  name: z.string().min(1, 'Name is required').max(100),
  webhook: z.string().optional().nullable(),  // 允许URL或邮箱地址
  token: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  chatId: z.string().optional().nullable(),
  configMethod: z.enum(['webhook', 'token', 'plugin']).optional().default('webhook'),
  sessionData: z.any().optional().nullable(),
  pluginPackage: z.string().optional().nullable(),
});

export const updateNotificationAccountSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  webhook: z.string().optional().nullable(),  // 允许URL或邮箱地址
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
  telegram_chat_id: z.string().optional().nullable(),
  discord_webhook: z.string().url().optional().nullable(),
  slack_webhook: z.string().url().optional().nullable(),
  wxpusher_app_token: z.string().optional().nullable(),
  wxpusher_uid: z.string().optional().nullable(),
  qmsg_key: z.string().optional().nullable(),
  qmsg_qq: z.string().optional().nullable(),
  channel_webhooks: z.record(z.string()).optional().nullable(),
  reminder_emails: z.array(z.string().email()).optional(),
  alert_channels: z.array(z.string()).optional(),
  alert_emails: z.array(z.string().email()).optional(),
  alert_account_ids: z.array(z.number().int().positive()).optional(),
  timezone: z.string().max(50).optional().nullable(),
  default_test_email: z.string().email().optional().nullable(),
}).passthrough();

export const testConnectionSchema = z.object({
  accountId: z.coerce.number().int().positive().optional(),
  type: z.string().min(1).optional(),
  configMethod: z.enum(['webhook', 'token', 'plugin']).optional().default('webhook'),
  webhook: z.string().optional().nullable(),
  token: z.string().optional().nullable(),
  chatId: z.string().optional().nullable(),
  secret: z.string().optional().nullable(),
  sessionData: z.any().optional().nullable(),
}).refine(
  (data) => data.accountId != null || Boolean(data.type?.trim()),
  { message: '请提供 accountId 或渠道类型 type', path: ['accountId'] },
);

export const createRelationshipMappingSchema = z.object({
  event_id: z.number().int().positive('event_id is required'),
  from_relation: z.string().min(1, 'from_relation is required').max(100),
  to_relation: z.string().min(1, 'to_relation is required').max(100),
  recipient_email: z.string().email().optional().nullable(),
  recipient_type: z.string().max(50).optional().nullable(),
});

export const updateRelationshipMappingSchema = z.object({
  from_relation: z.string().min(1).max(100).optional(),
  to_relation: z.string().min(1).max(100).optional(),
  recipient_email: z.string().email().optional().nullable(),
  recipient_type: z.string().max(50).optional().nullable(),
});

export const saveReminderSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  dailyTime: z.string().max(10).optional().nullable(),
  daysBeforeList: z.array(z.number().int().min(0)).optional(),
  emailAddresses: z.array(z.string().email()).optional(),
});

export const saveEventTemplateSchema = z.object({
  event_type: z.string().min(1, 'event_type is required').max(50),
  template_content: z.string().min(1, 'template_content is required').max(5000),
});

export const batchDeleteSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'At least one id is required'),
});

export const csvImportSchema = z.object({
  csvData: z.string().min(1, 'csvData is required'),
});

export const backupImportSchema = z.object({
  version: z.string().optional(),
  exportedAt: z.string().optional(),
  events: z.array(z.object({
    name: z.string().min(1),
    type: z.string().optional(),
    date: z.string().optional(),
    calendar_type: z.string().optional(),
    lunar_date: z.any().optional().nullable(),
    reminder_config: z.any().optional(),
    notification_channels: z.any().optional(),
    person_name: z.string().optional().nullable(),
    birth_date: z.string().optional().nullable(),
    birth_date_lunar: z.string().optional().nullable(),
    reminder_recipient_name: z.string().optional().nullable(),
    reminder_recipient_email: z.string().optional().nullable(),
  })).optional(),
  relationshipMappings: z.array(z.object({
    event_id: z.number().optional(),
    from_relation: z.string(),
    to_relation: z.string(),
    recipient_email: z.string().optional().nullable(),
    recipient_type: z.string().optional().nullable(),
  })).optional(),
  eventTemplates: z.array(z.object({
    event_type: z.string(),
    template_content: z.string(),
  })).optional(),
});

export const pluginStartAuthSchema = z.object({
  qqNumber: z.string().optional(),
  phoneNumber: z.string().optional(),
  credentials: z.any().optional(),
  config: z.any().optional(),
});

export const pluginCheckAuthSchema = z.object({
  sessionData: z.any(),
});
