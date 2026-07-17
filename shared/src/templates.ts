/**
 * 通知模板系统
 * 支持预设模板和自定义模板，包含变量替换功能
 */

export interface NotificationTemplate {
  id: string;
  name: string;
  content: string;
  isPreset: boolean;
  variables: string[];
  description?: string;
}

// 可用变量列表
export const AVAILABLE_VARIABLES = [
  { key: '{{event_name}}', label: '事件名称', example: '妈妈生日' },
  { key: '{{event_date}}', label: '事件日期', example: '2026-05-04' },
  { key: '{{event_type}}', label: '事件类型', example: '生日' },
  { key: '{{person_name}}', label: '被提醒人', example: '妈妈' },
  { key: '{{days_until}}', label: '距离天数', example: '3' },
  { key: '{{blessing}}', label: '祝福语', example: '生日快乐！' },
  { key: '{{reminder_time}}', label: '提醒时间', example: '09:00' },
  { key: '{{lunar_date}}', label: '农历日期', example: '正月初一' },
  { key: '{{calendar_type}}', label: '历法类型', example: '农历' },
];

// 预设模板
export const PRESET_TEMPLATES: NotificationTemplate[] = [
  // 生日模板
  {
    id: 'birthday',
    name: '生日提醒',
    content: '{{person_name}}的生日还有{{days_until}}天。{{blessing}}',
    isPreset: true,
    variables: ['person_name', 'days_until', 'blessing'],
    description: '适用于生日提醒，包含被提醒人和祝福语',
  },
  {
    id: 'birthday_simple',
    name: '生日简洁版',
    content: '{{event_name}}还有{{days_until}}天',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '简洁的生日提醒',
  },
  {
    id: 'birthday_detailed',
    name: '生日详细版',
    content: '🎂 {{person_name}} 的生日还有 {{days_until}} 天！\n📅 日期：{{event_date}}\n🎉 {{blessing}}',
    isPreset: true,
    variables: ['person_name', 'days_until', 'event_date', 'blessing'],
    description: '详细的生日提醒，包含日期和祝福语',
  },
  // 纪念日模板
  {
    id: 'anniversary',
    name: '纪念日提醒',
    content: '💍 {{event_name}} 还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于结婚纪念日、恋爱纪念日等',
  },
  {
    id: 'anniversary_simple',
    name: '纪念日简洁版',
    content: '💍 {{event_name}} 还有 {{days_until}} 天',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '简洁的纪念日提醒',
  },
  // 考试模板
  {
    id: 'exam',
    name: '考试提醒',
    content: '📝 {{event_name}} 还有 {{days_until}} 天，加油！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于考试、面试等重要日期',
  },
  {
    id: 'exam_urgent',
    name: '考试紧急提醒',
    content: '🚨 {{event_name}} 还有 {{days_until}} 天！抓紧复习！',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '紧急考试提醒',
  },
  // 节日模板
  {
    id: 'holiday',
    name: '节日提醒',
    content: '🎊 {{event_name}} 还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于传统节日、法定假日等',
  },
  {
    id: 'holiday_family',
    name: '节日家庭版',
    content: '🎊 {{event_name}} 还有 {{days_until}} 天！\n👨‍👩‍👧‍👦 记得准备团聚哦！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适合家庭聚会的节日提醒',
  },
  // 会议模板
  {
    id: 'meeting',
    name: '会议提醒',
    content: '📋 {{event_name}} 还有 {{days_until}} 天\n⏰ 请提前准备会议材料',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于会议、面试等',
  },
  // 截止日期模板
  {
    id: 'deadline',
    name: '截止日期提醒',
    content: '⏰ {{event_name}} 还有 {{days_until}} 天截止！请尽快完成',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于项目截止、报名截止等',
  },
  // 旅行模板
  {
    id: 'travel',
    name: '旅行提醒',
    content: '✈️ {{event_name}} 还有 {{days_until}} 天\n🧳 记得准备行李和证件',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于旅行、出差等',
  },
  // 毕业模板
  {
    id: 'graduation',
    name: '毕业提醒',
    content: '🎓 {{event_name}} 还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于毕业典礼等',
  },
  // 婚礼模板
  {
    id: 'wedding',
    name: '婚礼提醒',
    content: '💒 {{event_name}} 还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于婚礼、订婚等',
  },
  // 医疗模板
  {
    id: 'medical',
    name: '医疗提醒',
    content: '🏥 {{event_name}} 还有 {{days_until}} 天\n📋 请带好病历和医保卡',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于体检、复诊、手术等',
  },
  // 会议模板
  {
    id: 'meeting',
    name: '会议提醒',
    content: '📋 {{event_name}} 还有 {{days_until}} 天\n⏰ 请提前准备会议材料',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于会议、面试等',
  },
  // 截止日期模板
  {
    id: 'deadline',
    name: '截止日期提醒',
    content: '⏰ {{event_name}} 还有 {{days_until}} 天截止！\n📌 请尽快完成',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于项目截止、报名截止等',
  },
  {
    id: 'deadline_urgent',
    name: '截止日期紧急',
    content: '🚨 {{event_name}} 仅剩 {{days_until}} 天！请立即处理！',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '紧急截止日期提醒',
  },
  // 旅行模板
  {
    id: 'travel',
    name: '旅行提醒',
    content: '✈️ {{event_name}} 还有 {{days_until}} 天\n🧳 记得提前准备行李和证件',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于旅行、出差等',
  },
  // 毕业模板
  {
    id: 'graduation',
    name: '毕业提醒',
    content: '🎓 {{event_name}} 还有 {{days_until}} 天！\n🎉 {{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于毕业典礼等',
  },
  // 农历生日
  {
    id: 'birthday_lunar',
    name: '农历生日',
    content: '🎂 {{person_name}} 的农历生日还有 {{days_until}} 天！\n🌙 农历：{{lunar_date}}\n📅 公历：{{event_date}}\n🎉 {{blessing}}',
    isPreset: true,
    variables: ['person_name', 'days_until', 'lunar_date', 'event_date', 'blessing'],
    description: '农历生日提醒，含双历日期',
  },
  {
    id: 'birthday_both',
    name: '双历生日',
    content: '🎂 {{person_name}} 生日提醒（公历+农历）\n📅 公历：{{event_date}} | 🌙 农历：{{lunar_date}}\n还有 {{days_until}} 天 · {{blessing}}',
    isPreset: true,
    variables: ['person_name', 'days_until', 'event_date', 'lunar_date', 'blessing'],
    description: '同时记录公历与农历的生日',
  },
  // 传统节日
  {
    id: 'spring_festival',
    name: '春节提醒',
    content: '🧧 {{event_name}} 还有 {{days_until}} 天！记得准备年货和红包～',
    isPreset: true,
    variables: ['event_name', 'days_until'],
  },
  {
    id: 'mid_autumn',
    name: '中秋提醒',
    content: '🥮 {{event_name}} 还有 {{days_until}} 天！月圆人团圆。',
    isPreset: true,
    variables: ['event_name', 'days_until'],
  },
  {
    id: 'dragon_boat',
    name: '端午提醒',
    content: '🐲 {{event_name}} 还有 {{days_until}} 天！记得吃粽子。',
    isPreset: true,
    variables: ['event_name', 'days_until'],
  },
  {
    id: 'qixi',
    name: '七夕提醒',
    content: '💕 {{event_name}} 还有 {{days_until}} 天！',
    isPreset: true,
    variables: ['event_name', 'days_until'],
  },
  // 通用模板
  {
    id: 'generic',
    name: '通用提醒',
    content: '提醒一下：{{event_name}}还有{{days_until}}天。',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于所有类型的事件',
  },
  {
    id: 'detailed',
    name: '详细提醒',
    content: '{{event_name}}，日期{{event_date}}，还有{{days_until}}天。{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'event_date', 'person_name', 'days_until', 'blessing'],
    description: '显示完整的事件信息',
  },
];

/** 批量邮件预设 — 见 broadcast-templates.ts */
export { BROADCAST_PRESET_TEMPLATES, BROADCAST_TEMPLATE_CATEGORIES, buildBroadcastEmail, renderBroadcastTemplate } from './broadcast-templates.js';
export type { BroadcastTemplateCategory, BroadcastGreetingVariant } from './broadcast-templates.js';

// 事件类型到模板的映射
export const EVENT_TYPE_TEMPLATES: Record<string, string[]> = {
  birthday: ['birthday', 'birthday_lunar', 'birthday_both', 'birthday_simple', 'birthday_detailed', 'generic', 'detailed'],
  exam: ['exam', 'exam_urgent', 'generic', 'detailed'],
  anniversary: ['anniversary', 'anniversary_simple', 'generic', 'detailed'],
  holiday: ['holiday', 'holiday_family', 'spring_festival', 'mid_autumn', 'dragon_boat', 'qixi', 'generic', 'detailed'],
  meeting: ['meeting', 'generic', 'detailed'],
  deadline: ['deadline', 'deadline_urgent', 'generic', 'detailed'],
  travel: ['travel', 'generic', 'detailed'],
  graduation: ['graduation', 'generic', 'detailed'],
  wedding: ['wedding', 'anniversary', 'generic', 'detailed'],
  medical: ['medical', 'generic', 'detailed'],
  other: ['generic', 'detailed'],
};

/**
 * 替换模板变量（支持中英文变量）
 */
export function renderTemplate(template: string, data: Record<string, string>): string {
  let result = template;
  
  // 英文变量映射
  const enVarMap: Record<string, string> = {
    '{{event_name}}': data.event_name || '',
    '{{event_date}}': data.event_date || '',
    '{{event_type}}': data.event_type || '',
    '{{person_name}}': data.person_name || '',
    '{{days_until}}': data.days_until || '',
    '{{blessing}}': data.blessing || '',
    '{{reminder_time}}': data.reminder_time || '',
    '{{lunar_date}}': data.lunar_date || '',
    '{{calendar_type}}': data.calendar_type || '',
  };
  
  // 中文变量映射
  const cnVarMap: Record<string, string> = {
    '{{事件名}}': data.event_name || '',
    '{{日期}}': data.event_date || '',
    '{{类型}}': data.event_type || '',
    '{{被提醒人}}': data.person_name || '',
    '{{天数}}': data.days_until || '',
    '{{祝福语}}': data.blessing || '',
    '{{时间}}': data.reminder_time || '',
    '{{农历}}': data.lunar_date || '',
    '{{历法}}': data.calendar_type || '',
  };
  
  // 替换英文变量
  for (const [key, value] of Object.entries(enVarMap)) {
    result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  
  // 替换中文变量
  for (const [key, value] of Object.entries(cnVarMap)) {
    result = result.replace(new RegExp(key.replace(/[{}]/g, '\\$&'), 'g'), value);
  }
  
  return result;
}

/**
 * 获取事件类型标签
 */
export function getEventTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    birthday: '生日',
    exam: '考试',
    anniversary: '纪念日',
    holiday: '节日',
    other: '其他',
  };
  return labels[type] || type;
}

/**
 * 生成通知内容
 */
export function generateNotificationContent(
  template: string | undefined,
  event: {
    name: string;
    date: string;
    type: string;
    personName?: string;
    lunarDate?: string;
    calendarType?: string;
  },
  daysUntil: number,
  blessing: string,
  reminderTime?: string
): string {
  // 如果没有自定义模板，使用默认模板
  const templateContent = template || '{{event_name}} 还有 {{days_until}} 天';
  
  // 准备变量数据
  const data: Record<string, string> = {
    event_name: event.name,
    event_date: event.date,
    event_type: getEventTypeLabel(event.type),
    person_name: event.personName || '',
    days_until: String(daysUntil),
    blessing: blessing,
    reminder_time: reminderTime || '',
    lunar_date: event.lunarDate || '',
    calendar_type: event.calendarType === 'lunar' ? '农历' : event.calendarType === 'both' ? '双历' : '公历',
  };
  
  return renderTemplate(templateContent, data);
}

/**
 * 预览模板
 */
export function previewTemplate(template: string): string {
  const sampleData: Record<string, string> = {
    event_name: '妈妈生日',
    event_date: '2026-05-04',
    event_type: '生日',
    person_name: '妈妈',
    days_until: '3',
    blessing: '祝妈妈生日快乐，永远年轻美丽',
    reminder_time: '09:00',
  };
  
  return renderTemplate(template, sampleData);
}
