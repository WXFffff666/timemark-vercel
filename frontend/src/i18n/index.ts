const resources = {
  zh: {
    'nav.dashboard': '首页',
    'nav.analytics': '统计',
    'nav.reminders': '提醒',
    'nav.security': '安全',
    'nav.inbox': '收件箱',
    'nav.settings': '设置',
    'nav.channels': '渠道',
    'login.submit': '登录',
  },
  en: {
    'nav.dashboard': 'Home',
    'nav.analytics': 'Stats',
    'nav.reminders': 'Reminders',
    'nav.security': 'Security',
    'nav.inbox': 'Inbox',
    'nav.settings': 'Settings',
    'nav.channels': 'Channels',
    'login.submit': 'Sign in',
  },
} as const;

type Lang = keyof typeof resources;
type I18nKey = keyof typeof resources.zh;

let currentLang: Lang = (localStorage.getItem('lang') as Lang) || 'zh';

export function setLang(lang: Lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
  window.dispatchEvent(new CustomEvent('timemark-lang-change'));
}

export function t(key: I18nKey): string {
  return resources[currentLang][key] || resources.zh[key] || key;
}

export function getLang(): Lang {
  return currentLang;
}
