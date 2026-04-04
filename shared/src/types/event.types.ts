export type EventType = 'birthday' | 'exam' | 'anniversary' | 'holiday' | 'other';
export type CalendarType = 'gregorian' | 'lunar' | 'both';

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

export type NotificationChannel =
  | 'email'
  | 'feishu'
  | 'dingtalk'
  | 'wecom'
  | 'telegram'
  | 'discord'
  | 'slack'
  | 'wechat'
  | 'qq'
  | 'whatsapp'
  | 'google_chat'
  | 'signal'
  | 'imessage'
  | 'bluebubbles'
  | 'irc'
  | 'microsoft_teams'
  | 'matrix'
  | 'line'
  | 'mattermost'
  | 'nextcloud_talk'
  | 'nostr'
  | 'synology_chat'
  | 'tlon'
  | 'twitch'
  | 'zalo'
  | 'zalo_personal'
  | 'network_chat';

export interface ReminderConfig {
  enabled: boolean;
  daysBeforeList: number[];
  customMessage?: string;
  emailRecipients: string[];
  channels?: NotificationChannel[];
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
}

export interface NotificationAccount {
  id: string;
  type: Exclude<NotificationChannel, 'email'>;
  name: string;
  webhook?: string;
  token?: string;
  chatId?: string;
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
