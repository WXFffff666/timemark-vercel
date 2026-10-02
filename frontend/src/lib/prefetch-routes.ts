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
  '/todos': () => import('../pages/Todos'),
  '/expiry': () => import('../pages/Expiry'),
  '/inventory': () => import('../pages/Inventory'),
  '/maintenance': () => import('../pages/Maintenance'),
  '/documents': () => import('../pages/Documents'),
  '/habits': () => import('../pages/Habits'),
  '/medications': () => import('../pages/Medications'),
  '/goals': () => import('../pages/Goals'),
  '/inbox': () => import('../pages/Inbox'),
  '/notification-rules': () => import('../pages/NotificationRules'),
  '/trigger-logs': () => import('../pages/TriggerLogs'),
  '/templates': () => import('../pages/Templates'),
  '/agent-console': () => import('../pages/AgentConsole'),
  '/ask': () => import('../pages/Ask'),
  '/today': () => import('../pages/Today'),
  '/data-health': () => import('../pages/DataHealth'),
  '/annual-report': () => import('../pages/AnnualReport'),
  '/assistant': () => import('../pages/Assistant'),
  '/cron-monitor': () => import('../pages/CronMonitor'),
  '/lunar-holidays': () => import('../pages/LunarHolidays'),
  '/login-history': () => import('../pages/LoginHistory'),
  '/integrations-docs': () => import('../pages/IntegrationsDocs'),
  '/deploy-wizard': () => import('../pages/DeployWizard'),
  '/docker-migration': () => import('../pages/DockerMigration'),
};

const prefetched = new Set<string>();

export function prefetchRoute(path: string) {
  if (prefetched.has(path)) return;
  const load = loaders[path];
  if (!load) return;
  prefetched.add(path);
  load().catch(() => prefetched.delete(path));
}
