-- 创建默认管理员账户
INSERT INTO users (username, password_hash, totp_secret)
VALUES ('admin', '$2a$10$MRqDgkKqsxdy/aEhSUsoy.Y5x.9fN5pItImBgQAK/.uWczeQ8rOeS', NULL)
ON CONFLICT (username) DO NOTHING;

-- 创建测试用户
INSERT INTO users (username, password_hash, totp_secret)
VALUES ('testuser', '$2a$10$MRqDgkKqsxdy/aEhSUsoy.Y5x.9fN5pItImBgQAK/.uWczeQ8rOeS', NULL)
ON CONFLICT (username) DO NOTHING;

-- 创建测试事件
INSERT INTO events (user_id, name, type, date, calendar_type, reminder_emails, reminder_days_before, notification_channels)
SELECT 
  u.id,
  'Test Birthday',
  'birthday',
  CURRENT_DATE + INTERVAL '30 days',
  'gregorian',
  '["test@example.com"]'::json,
  '[1, 3, 7]'::json,
  '["email"]'::json
FROM users u WHERE u.username = 'admin'
ON CONFLICT DO NOTHING;
