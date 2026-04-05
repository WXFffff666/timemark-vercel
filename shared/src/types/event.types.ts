export type EventType = 'birthday' | 'exam' | 'anniversary' | 'holiday' | 'other';
export type CalendarType = 'gregorian' | 'lunar' | 'both';

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

export type NotificationChannel =
  // Email (mandatory)
  | 'email'
  // Webhook channels
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'discord'
  | 'slack'
  | 'googlechat'
  | 'irc'
  | 'synologychat'
  | 'twitch'
  // Token-based channels
  | 'telegram'
  | 'line'
  | 'matrix'
  | 'mattermost'
  | 'msteams'
  | 'nextcloudtalk'
  | 'wxpusher'
  | 'qmsg'
  // Legacy/other channels
  | 'wechat'
  | 'qq'
  | 'whatsapp'
  | 'signal'
  | 'imessage'
  | 'bluebubbles'
  | 'microsoft_teams'
  | 'nostr'
  | 'tlon'
  | 'zalo'
  | 'zalo_personal'
  | 'network_chat'
  | 'google_chat'
  | 'synology_chat'
  | 'nextcloud_talk'
  | 'qqbot';

export interface ReminderConfig {
  enabled: boolean;
  daysBeforeList: number[];
  customMessage?: string;
  emailRecipients: string[];
  channels?: NotificationChannel[] | string[];
  accountIds?: string[];
  reminderTime?: string; // 自定义提醒时间 HH:mm
}

export interface Event {
  id: string;
  userId: string;
  name: string;
  type: EventType;
  date: string;
  calendarType: CalendarType;
  lunarDate?: LunarDate;
  reminderConfig: ReminderConfig;
  personName?: string;
  birthDate?: string;
  birthDateLunar?: string;
  relationshipMappingId?: string;
  createdAt: string;
}

export interface CreateEventRequest {
  name: string;
  type: EventType;
  date: string;
  calendarType: CalendarType;
  lunarDate?: LunarDate;
  reminderConfig: ReminderConfig;
  personName?: string;
  birthDate?: string;
  birthDateLunar?: string;
  relationshipMappingId?: string;
}

export interface NotificationAccount {
  id: string;
  type: Exclude<NotificationChannel, 'email'>;
  name: string;
  webhook?: string;
  token?: string;
  chatId?: string;
  configMethod?: 'webhook' | 'token' | 'plugin';
  sessionData?: any;
  pluginPackage?: string;
}

export interface RelationshipMapping {
  id: string;
  eventId: string;
  fromRelation: string;
  toRelation: string;
  recipientEmail?: string;
  recipientType?: string;
}

export interface EventTemplate {
  id: string;
  eventId: string;
  reminderId: string;
  reminderIdentity: string;
  eventSubject: string;
  relationshipMappings: RelationshipMapping[];
}
