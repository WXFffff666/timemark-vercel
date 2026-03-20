-- 创建默认管理员账户
INSERT INTO users (username, password_hash, totp_secret)
VALUES ('admin', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$xvJQQqZ8yH5K5pN8vL9mJ8wQ7vN5pL8mJ9wQ8vN6pM', NULL)
ON CONFLICT (username) DO NOTHING;

-- 创建测试用户
INSERT INTO users (username, password_hash, totp_secret)
VALUES ('testuser', '$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHRzYWx0c2FsdA$xvJQQqZ8yH5K5pN8vL9mJ8wQ7vN5pL8mJ9wQ8vN6pM', NULL)
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
