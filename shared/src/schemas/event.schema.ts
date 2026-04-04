import { z } from 'zod';

export const reminderConfigSchema = z.object({
  enabled: z.boolean(),
  daysBeforeList: z.array(z.number().int().min(0)),
  customMessage: z.string().optional(),
  emailRecipients: z.array(z.string().email()),
  channels: z.array(z.string()).optional(),
  accountIds: z.array(z.string()).optional(),
  reminderTime: z.string().optional(), // 自定义提醒时间 HH:mm
});

export const createEventSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['birthday', 'exam', 'anniversary', 'holiday', 'other']),
  date: z.string(),
  calendarType: z.enum(['gregorian', 'lunar', 'both']),
  lunarDate: z.object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(30),
    isLeap: z.boolean(),
  }).optional(),
  // 双日历模式下的第二个日期（可选）
  secondDate: z.string().optional(),
  secondCalendarType: z.enum(['gregorian', 'lunar']).optional(),
  secondLunarDate: z.object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(30),
    isLeap: z.boolean(),
  }).optional(),
  reminderConfig: reminderConfigSchema,
  personName: z.string().optional(),
  birthDate: z.string().optional(),
  birthDateLunar: z.string().optional(),
});

export const updateEventSchema = createEventSchema.partial();
