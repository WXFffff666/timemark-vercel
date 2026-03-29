export type EventType = 'birthday' | 'exam' | 'anniversary' | 'holiday' | 'other';
export type CalendarType = 'gregorian' | 'lunar';

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

export type NotificationChannel = 'email' | 'feishu' | 'dingtalk' | 'wecom' | 'telegram';

export interface ReminderConfig {
  enabled: boolean;
  daysBeforeList: number[];
  customMessage?: string;
  emailRecipients: string[];
  channels?: NotificationChannel[];
  accountIds?: string[];
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
  type: 'feishu' | 'dingtalk' | 'wecom' | 'telegram';
  name: string;
  webhook?: string;
  token?: string;
  chatId?: string;
}

export interface RelationshipMapping {
  id: string;
  fromRelation: string;
  toRelation: string;
}

export interface EventTemplate {
  id: string;
  eventId: string;
  reminderId: string;
  reminderIdentity: string;
  eventSubject: string;
  relationshipMappings: RelationshipMapping[];
}
