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
];

// 预设模板
export const PRESET_TEMPLATES: NotificationTemplate[] = [
  {
    id: 'birthday',
    name: '生日提醒',
    content: '🎂 {{person_name}} 的生日还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['person_name', 'days_until', 'blessing'],
    description: '适用于生日提醒，包含被提醒人和祝福语',
  },
  {
    id: 'anniversary',
    name: '纪念日提醒',
    content: '💍 {{event_name}} 还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于结婚纪念日、恋爱纪念日等',
  },
  {
    id: 'exam',
    name: '考试提醒',
    content: '📝 {{event_name}} 还有 {{days_until}} 天，加油！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于考试、面试等重要日期',
  },
  {
    id: 'holiday',
    name: '节日提醒',
    content: '🎊 {{event_name}} 还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['event_name', 'days_until', 'blessing'],
    description: '适用于传统节日、法定假日等',
  },
  {
    id: 'generic',
    name: '通用提醒',
    content: '📅 {{event_name}} 还有 {{days_until}} 天',
    isPreset: true,
    variables: ['event_name', 'days_until'],
    description: '适用于所有类型的事件',
  },
  {
    id: 'detailed',
    name: '详细提醒',
    content: '📅 事件：{{event_name}}\n📆 日期：{{event_date}}\n👤 被提醒人：{{person_name}}\n⏰ 距离：{{days_until}} 天\n🎉 {{blessing}}',
    isPreset: true,
    variables: ['event_name', 'event_date', 'person_name', 'days_until', 'blessing'],
    description: '显示完整的事件信息',
  },
];

/**
 * 替换模板变量
 */
export function renderTemplate(template: string, data: Record<string, string>): string {
  let result = template;
  
  for (const [key, value] of Object.entries(data)) {
    const placeholder = `{{${key}}}`;
    result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), value || '');
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
