import type { TranslationKey } from './zh';

/** English resources. `Record<TranslationKey, string>` fails the build if a key is missing. */
export const en: Record<TranslationKey, string> = {
  'nav.dashboard': 'Home',
  'nav.analytics': 'Stats',
  'nav.reminders': 'Reminders',
  'nav.security': 'Security',
  'nav.inbox': 'Inbox',
  'nav.settings': 'Settings',
  'nav.channels': 'Channels',
  'nav.expiry': 'Expiry',
  'nav.inventory': 'Inventory',
  'nav.maintenance': 'Maintenance',
  'nav.documents': 'Documents',
  'login.submit': 'Sign in',
};
