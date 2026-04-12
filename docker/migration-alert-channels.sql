-- 添加告警渠道字段
ALTER TABLE user_configs ADD COLUMN IF NOT EXISTS alert_channels TEXT DEFAULT '["email"]';