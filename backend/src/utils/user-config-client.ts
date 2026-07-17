/** 用户配置 API 脱敏：不向客户端返回明文密钥 */

const SECRET_FIELD_FLAGS: Array<{ field: string; flag: string }> = [
  { field: 'resend_api_key', flag: 'resend_api_key_configured' },
  { field: 'github_token', flag: 'github_token_configured' },
  { field: 'feishu_webhook', flag: 'feishu_webhook_configured' },
  { field: 'wecom_webhook', flag: 'wecom_webhook_configured' },
  { field: 'dingtalk_webhook', flag: 'dingtalk_webhook_configured' },
  { field: 'dingtalk_secret', flag: 'dingtalk_secret_configured' },
  { field: 'telegram_bot_token', flag: 'telegram_bot_token_configured' },
  { field: 'discord_webhook', flag: 'discord_webhook_configured' },
  { field: 'slack_webhook', flag: 'slack_webhook_configured' },
  { field: 'wxpusher_app_token', flag: 'wxpusher_app_token_configured' },
  { field: 'wxpusher_uid', flag: 'wxpusher_uid_configured' },
  { field: 'qmsg_key', flag: 'qmsg_key_configured' },
  { field: 'qmsg_qq', flag: 'qmsg_qq_configured' },
];

export function maskUserConfigForClient(config: Record<string, unknown> | null): Record<string, unknown> {
  if (!config) return {};

  const channelWebhooks = config.channel_webhooks;
  const channelWebhookConfigured =
    channelWebhooks &&
    typeof channelWebhooks === 'object' &&
    Object.values(channelWebhooks as Record<string, unknown>).some((v) => !!v);

  const masked: Record<string, unknown> = {
    timezone: config.timezone ?? 'Asia/Shanghai',
    quiet_hours_start: config.quiet_hours_start ?? null,
    quiet_hours_end: config.quiet_hours_end ?? null,
    default_test_email: config.default_test_email ?? null,
    reminder_emails: config.reminder_emails ?? [],
    alert_channels: config.alert_channels ?? [],
    alert_emails: config.alert_emails ?? [],
    alert_account_ids: config.alert_account_ids ?? [],
    telegram_chat_id: config.telegram_chat_id ?? null,
    markdown_email_template: config.markdown_email_template ?? null,
    notification_preset: config.notification_preset ?? null,
    api_scopes: config.api_scopes ?? 'read,write',
    channel_webhooks_configured: !!channelWebhookConfigured,
  };

  for (const { field, flag } of SECRET_FIELD_FLAGS) {
    masked[flag] = !!config[field];
  }

  return masked;
}
