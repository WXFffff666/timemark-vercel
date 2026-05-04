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
  // 生日模板
  {
    id: 'birthday',
    name: '生日提醒',
    content: '🎂 {{person_name}} 的生日还有 {{days_until}} 天！{{blessing}}',
    isPreset: true,
    variables: ['person_name', 'days_until', 'blessing'],
    description: '适用于生日提醒，包含被提醒人和祝福语',
  },
  {
    id: 'birthday_simple',
    name: '生日简洁版',
    content: '🎂 {{event_name}} 还有 {{days_until}} 天',
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
  // 通用模板
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

// 事件类型到模板的映射
export const EVENT_TYPE_TEMPLATES: Record<string, string[]> = {
  birthday: ['birthday', 'birthday_simple', 'birthday_detailed', 'generic', 'detailed'],
  exam: ['exam', 'exam_urgent', 'generic', 'detailed'],
  anniversary: ['anniversary', 'anniversary_simple', 'generic', 'detailed'],
  holiday: ['holiday', 'holiday_family', 'generic', 'detailed'],
  meeting: ['generic', 'detailed'],
  deadline: ['generic', 'detailed'],
  travel: ['generic', 'detailed'],
  graduation: ['generic', 'detailed'],
  wedding: ['anniversary', 'anniversary_simple', 'generic', 'detailed'],
  medical: ['generic', 'detailed'],
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
