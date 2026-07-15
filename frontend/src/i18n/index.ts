const resources = {
  zh: {
    'nav.dashboard': '仪表盘',
    'nav.inbox': '收件箱',
    'nav.settings': '设置',
    'login.submit': '登录',
  },
  en: {
    'nav.dashboard': 'Dashboard',
    'nav.inbox': 'Inbox',
    'nav.settings': 'Settings',
    'login.submit': 'Sign in',
  },
} as const;

type Lang = keyof typeof resources;

let currentLang: Lang = (localStorage.getItem('lang') as Lang) || 'zh';

export function setLang(lang: Lang) {
  currentLang = lang;
  localStorage.setItem('lang', lang);
}

export function t(key: keyof typeof resources.zh): string {
  return resources[currentLang][key] || resources.zh[key] || key;
}

export function getLang(): Lang {
  return currentLang;
}
