import { query } from '../db';
import { encrypt, decrypt } from '../../../shared/src/crypto';

const MASTER_KEY = process.env.MASTER_KEY!;

export async function saveUserConfig(userId: number, config: any): Promise<void> {
  const e = (v: string | undefined) => v ? encrypt(v, MASTER_KEY) : null;
  await query(
    `INSERT INTO user_configs (user_id, encrypted_resend_key, encrypted_github_token, encrypted_feishu_webhook, encrypted_wecom_webhook, encrypted_dingtalk_webhook, encrypted_dingtalk_secret, encrypted_telegram_bot_token, telegram_chat_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (user_id) DO UPDATE SET
       encrypted_resend_key = COALESCE(EXCLUDED.encrypted_resend_key, user_configs.encrypted_resend_key),
       encrypted_github_token = COALESCE(EXCLUDED.encrypted_github_token, user_configs.encrypted_github_token),
       encrypted_feishu_webhook = COALESCE(EXCLUDED.encrypted_feishu_webhook, user_configs.encrypted_feishu_webhook),
       encrypted_wecom_webhook = COALESCE(EXCLUDED.encrypted_wecom_webhook, user_configs.encrypted_wecom_webhook),
       encrypted_dingtalk_webhook = COALESCE(EXCLUDED.encrypted_dingtalk_webhook, user_configs.encrypted_dingtalk_webhook),
       encrypted_dingtalk_secret = COALESCE(EXCLUDED.encrypted_dingtalk_secret, user_configs.encrypted_dingtalk_secret),
       encrypted_telegram_bot_token = COALESCE(EXCLUDED.encrypted_telegram_bot_token, user_configs.encrypted_telegram_bot_token),
       telegram_chat_id = COALESCE(EXCLUDED.telegram_chat_id, user_configs.telegram_chat_id)`,
    [userId, e(config.resend_api_key), e(config.github_token), e(config.feishu_webhook), e(config.wecom_webhook),
     e(config.dingtalk_webhook), e(config.dingtalk_secret), e(config.telegram_bot_token), config.telegram_chat_id || null]
  );
}

export async function getUserConfig(userId: number): Promise<any> {
  const result = await query(`SELECT * FROM user_configs WHERE user_id = $1`, [userId]);
  if (result.rows.length === 0) return null;
  const r = result.rows[0];
  const d = (v: string | null) => v ? decrypt(v, MASTER_KEY) : null;
  return {
    resend_api_key: d(r.encrypted_resend_key),
    github_token: d(r.encrypted_github_token),
    feishu_webhook: d(r.encrypted_feishu_webhook),
    wecom_webhook: d(r.encrypted_wecom_webhook),
    dingtalk_webhook: d(r.encrypted_dingtalk_webhook),
    dingtalk_secret: d(r.encrypted_dingtalk_secret),
    telegram_bot_token: d(r.encrypted_telegram_bot_token),
    telegram_chat_id: r.telegram_chat_id,
  };
}
