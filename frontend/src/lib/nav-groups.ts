import type { TranslationKey } from '@/i18n/resources/zh';
import {
  LayoutDashboard, CalendarCheck, BarChart3, FileBarChart, ListTodo, MessageCircleQuestion,
  Bell, Cable, ScrollText, BellRing, FileStack, Inbox, Megaphone,
  AlarmClock, Package, Wrench, FileText, Flame, Pill, Target, Users, CalendarDays, CalendarRange,
  Sparkles, Bot, HeartPulse, Activity, Shield, KeyRound, BookOpen, Rocket, Settings, Container, Cpu,
  type LucideIcon,
} from 'lucide-react';

/**
 * 导航的唯一真相源。
 *
 * 以前入口散落在各个页面的按钮里，结果 App.tsx 挂了 38 条路由却有 8 条没有任何入口
 * （/today /ask /assistant /agent-console /data-health /cron-monitor /lunar-holidays /
 * docker-migration）——功能写完了、路由挂上了，用户却找不到，只能手敲地址。
 *
 * 这里按「个人与家庭重要事项运行台」的四组来组织，并且**必须覆盖 App.tsx 的每一条
 * 受保护路由**——nav-groups.test.ts 会逐条核对，新增页面忘了加入口就直接测试失败。
 *
 * 文案走既有的 i18n `nav.*` 键（zh.ts / en.ts），不在这里硬编码中文。
 */

export interface NavItem {
  path: string;
  icon: LucideIcon;
  /** 必须是 zh.ts 里存在的键：类型层面就挡住"引用了不存在的文案" */
  labelKey: TranslationKey;
  /** 移动端底部栏主位；未标记的进「更多」面板 */
  primary?: boolean;
}

export interface NavGroup {
  id: string;
  /** 分组标题的 i18n 键 */
  labelKey: TranslationKey;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'overview',
    labelKey: 'nav.group.overview',
    items: [
      { path: '/dashboard', icon: LayoutDashboard, labelKey: 'nav.dashboard', primary: true },
      { path: '/today', icon: CalendarCheck, labelKey: 'nav.today', primary: true },
      { path: '/todos', icon: ListTodo, labelKey: 'nav.todos' },
      { path: '/analytics', icon: BarChart3, labelKey: 'nav.analytics' },
      { path: '/annual-report', icon: FileBarChart, labelKey: 'nav.annualReport' },
      { path: '/ask', icon: MessageCircleQuestion, labelKey: 'nav.ask' },
    ],
  },
  {
    id: 'reminders',
    labelKey: 'nav.group.reminders',
    items: [
      { path: '/reminders', icon: Bell, labelKey: 'nav.reminders', primary: true },
      { path: '/channels', icon: Cable, labelKey: 'nav.channels' },
      { path: '/trigger-logs', icon: ScrollText, labelKey: 'nav.triggerLogs' },
      { path: '/notification-rules', icon: BellRing, labelKey: 'nav.notificationRules' },
      { path: '/templates', icon: FileStack, labelKey: 'nav.templates' },
      { path: '/inbox', icon: Inbox, labelKey: 'nav.inbox' },
      { path: '/broadcast', icon: Megaphone, labelKey: 'nav.broadcast' },
    ],
  },
  {
    id: 'life',
    labelKey: 'nav.group.life',
    items: [
      { path: '/contacts', icon: Users, labelKey: 'nav.contacts' },
      { path: '/calendar', icon: CalendarDays, labelKey: 'nav.calendar' },
      { path: '/expiry', icon: AlarmClock, labelKey: 'nav.expiry' },
      { path: '/inventory', icon: Package, labelKey: 'nav.inventory' },
      { path: '/maintenance', icon: Wrench, labelKey: 'nav.maintenance' },
      { path: '/documents', icon: FileText, labelKey: 'nav.documents' },
      { path: '/habits', icon: Flame, labelKey: 'nav.habits' },
      { path: '/medications', icon: Pill, labelKey: 'nav.medications' },
      { path: '/goals', icon: Target, labelKey: 'nav.goals' },
      { path: '/lunar-holidays', icon: CalendarRange, labelKey: 'nav.lunarHolidays' },
    ],
  },
  {
    id: 'system',
    labelKey: 'nav.group.system',
    items: [
      { path: '/assistant', icon: Sparkles, labelKey: 'nav.assistant' },
      { path: '/local-ai', icon: Cpu, labelKey: 'nav.localAi' },
      { path: '/agent-console', icon: Bot, labelKey: 'nav.agentConsole' },
      { path: '/data-health', icon: HeartPulse, labelKey: 'nav.dataHealth' },
      { path: '/cron-monitor', icon: Activity, labelKey: 'nav.cronMonitor' },
      { path: '/security', icon: Shield, labelKey: 'nav.security' },
      { path: '/login-history', icon: KeyRound, labelKey: 'nav.loginHistory' },
      { path: '/integrations-docs', icon: BookOpen, labelKey: 'nav.integrationsDocs' },
      { path: '/deploy-wizard', icon: Rocket, labelKey: 'nav.deployWizard' },
      { path: '/docker-migration', icon: Container, labelKey: 'nav.dockerMigration' },
      { path: '/settings', icon: Settings, labelKey: 'nav.settings', primary: true },
    ],
  },
];

/** 移动端底部栏主位。顺序即显示顺序；其余入口进「更多」面板。 */
export const NAV_PRIMARY: NavItem[] = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.primary);

/** 全部入口，供「更多」面板与覆盖测试使用 */
export const NAV_ALL_PATHS: string[] = NAV_GROUPS.flatMap((g) => g.items).map((i) => i.path);

/** 全部文案键（含分组标题），供 i18n 完整性检查使用 */
export const NAV_ALL_LABEL_KEYS: string[] = [
  ...NAV_GROUPS.map((g) => g.labelKey),
  ...NAV_GROUPS.flatMap((g) => g.items.map((i) => i.labelKey)),
];