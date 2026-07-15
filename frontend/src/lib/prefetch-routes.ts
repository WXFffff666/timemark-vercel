/** Preload lazy route chunks on hover/touch to reduce navigation delay */

const loaders: Record<string, () => Promise<unknown>> = {
  '/dashboard': () => import('../pages/Dashboard'),
  '/settings': () => import('../pages/Settings'),
  '/reminders': () => import('../pages/Reminders'),
  '/security': () => import('../pages/Security'),
  '/analytics': () => import('../pages/Analytics'),
  '/channels': () => import('../pages/Channels'),
  '/contacts': () => import('../pages/Contacts'),
  '/broadcast': () => import('../pages/Broadcast'),
  '/calendar': () => import('../pages/Calendar'),
  '/inbox': () => import('../pages/Inbox'),
};

const prefetched = new Set<string>();

export function prefetchRoute(path: string) {
  if (prefetched.has(path)) return;
  const load = loaders[path];
  if (!load) return;
  prefetched.add(path);
  load().catch(() => prefetched.delete(path));
}
