/** Chinese resources — the default language (Chinese-first). */
export const zh = {
  'nav.dashboard': '首页',
  'nav.analytics': '统计',
  'nav.reminders': '提醒',
  'nav.security': '安全',
  'nav.inbox': '收件箱',
  'nav.settings': '设置',
  'nav.channels': '渠道',
  'nav.expiry': '到期',
  'nav.inventory': '库存',
  'nav.maintenance': '保养',
  'login.submit': '登录',
} as const;

/** Every valid translation key; `en` is compile-time checked against this. */
export type TranslationKey = keyof typeof zh;
