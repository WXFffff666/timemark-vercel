export type EventType = 'birthday' | 'exam' | 'anniversary' | 'holiday' | 'other';
export type CalendarType = 'gregorian' | 'lunar';

export interface LunarDate {
  year: number;
  month: number;
  day: number;
  isLeap: boolean;
}

export interface ReminderConfig {
  enabled: boolean;
  daysBeforeList: number[];
  customMessage?: string;
  emailRecipients: string[];
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
