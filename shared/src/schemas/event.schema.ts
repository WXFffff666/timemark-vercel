import { z } from 'zod';

export const reminderConfigSchema = z.object({
  enabled: z.boolean(),
  daysBeforeList: z.array(z.number().int().min(0)),
  customMessage: z.string().optional(),
  emailRecipients: z.array(z.string().email()),
  channels: z.array(z.string()).optional(),
  accountIds: z.array(z.string()).optional(),
  reminderTimes: z.array(z.string()).optional(), // 多选提醒时间 HH:mm 数组
  importSource: z.string().optional(),
});

export const recurringConfigSchema = z.object({
  enabled: z.boolean(),
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1),
  endType: z.enum(['never', 'count', 'date']),
  endCount: z.number().int().min(1).optional(),
  endDate: z.string().optional(),
});

export const createEventSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum(['birthday', 'exam', 'anniversary', 'holiday', 'meeting', 'deadline', 'travel', 'graduation', 'wedding', 'medical', 'other']),
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
  recurringConfig: recurringConfigSchema.optional(),
  // 被提醒人（生日/事件所有者）
  personName: z.string().optional().nullable(),
  birthDate: z.string().optional().nullable(),
  birthDateLunar: z.string().optional().nullable(),
  // 提醒人（接收通知的人）- 用于关系映射
  reminderRecipientName: z.string().optional().nullable(),
  reminderRecipientEmail: z.string().email().optional().nullable(),
  relationshipMappingId: z.string().optional(),
});

export const updateEventSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  type: z.enum(['birthday', 'exam', 'anniversary', 'holiday', 'other']).optional(),
  date: z.string().optional(),
  calendarType: z.enum(['gregorian', 'lunar', 'both']).optional(),
  lunarDate: z.object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(30),
    isLeap: z.boolean(),
  }).optional(),
  secondDate: z.string().optional(),
  secondCalendarType: z.enum(['gregorian', 'lunar']).optional(),
  secondLunarDate: z.object({
    year: z.number().int(),
    month: z.number().int().min(1).max(12),
    day: z.number().int().min(1).max(30),
    isLeap: z.boolean(),
  }).optional(),
  reminderConfig: z.object({
    enabled: z.boolean().optional(),
    daysBeforeList: z.array(z.number().int().min(0)).optional(),
    customMessage: z.string().optional(),
    emailRecipients: z.array(z.string().email()).optional(),
    channels: z.array(z.string()).optional(),
    accountIds: z.array(z.string()).optional(),
    reminderTimes: z.array(z.string()).optional(),
  }).optional(),
  recurringConfig: z.object({
    enabled: z.boolean().optional(),
    frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']).optional(),
    interval: z.number().int().min(1).optional(),
    endType: z.enum(['never', 'count', 'date']).optional(),
    endCount: z.number().int().min(1).optional(),
    endDate: z.string().optional(),
  }).optional(),
  personName: z.string().optional().nullable(),
  birthDate: z.string().optional().nullable(),
  birthDateLunar: z.string().optional().nullable(),
  reminderRecipientName: z.string().optional().nullable(),
  reminderRecipientEmail: z.string().email().optional().nullable(),
  relationshipMappingId: z.string().optional(),
});
