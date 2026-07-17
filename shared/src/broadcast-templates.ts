/**
 * 批量邮件模板：分类 + 问候语变体（二级选择）
 */

export interface BroadcastGreetingVariant {
  id: string;
  /** 问候语名称，如「温馨正式」 */
  name: string;
  /** 开头问候 HTML 片段，支持 {{contact_name}} */
  greetingHtml: string;
}

export interface BroadcastTemplateCategory {
  id: string;
  name: string;
  emoji: string;
  description: string;
  defaultSubject: string;
  /** 问候语变体（二级选项） */
  greetingVariants: BroadcastGreetingVariant[];
  /** 正文（问候语之后），支持 {{contact_name}} */
  bodyHtml: string;
  /** 结尾 */
  closingHtml: string;
}

export const BROADCAST_TEMPLATE_CATEGORIES: BroadcastTemplateCategory[] = [
  {
    id: 'holiday',
    name: '节日问候',
    emoji: '🎊',
    description: '春节、中秋等节日群发祝福',
    defaultSubject: '节日快乐 · 来自 TimeMark',
    greetingVariants: [
      { id: 'warm', name: '温馨祝福', greetingHtml: '<p>亲爱的 {{contact_name}}，</p><p>佳节将至，谨祝您与家人幸福安康、万事顺意！</p>' },
      { id: 'formal', name: '正式问候', greetingHtml: '<p>{{contact_name}} 您好，</p><p>值此佳节，恭祝您节日快乐、阖家欢乐。</p>' },
      { id: 'lively', name: '活泼轻松', greetingHtml: '<p>嗨 {{contact_name}}！🎉</p><p>节日快乐呀～愿你好心情天天在线！</p>' },
      { id: 'spring', name: '春节专属', greetingHtml: '<p>{{contact_name}} 新年好！🧧</p><p>祝您龙年大吉、财源广进、心想事成！</p>' },
    ],
    bodyHtml: '<p>感谢您一直以来的支持与信任。愿新的一年里，所盼皆所达，所行皆坦途。</p>',
    closingHtml: '<p style="margin-top:16px">此致<br/>敬礼</p>',
  },
  {
    id: 'birthday',
    name: '生日祝福',
    emoji: '🎂',
    description: '联系人生日群发祝福',
    defaultSubject: '🎂 生日快乐！',
    greetingVariants: [
      { id: 'warm', name: '温馨祝福', greetingHtml: '<p>亲爱的 {{contact_name}}，</p><p>在这个特别的日子里，祝您生日快乐！🎂</p>' },
      { id: 'fun', name: '活泼俏皮', greetingHtml: '<p>嗨 {{contact_name}}！🥳</p><p>生日快乐！又年轻一岁啦～</p>' },
      { id: 'formal', name: '正式得体', greetingHtml: '<p>{{contact_name}} 您好，</p><p>谨祝您生日快乐，身体健康、工作顺利。</p>' },
      { id: 'family', name: '家人口吻', greetingHtml: '<p>亲爱的 {{contact_name}}：</p><p>生日快乐！愿你被温柔以待，岁岁常欢愉。</p>' },
    ],
    bodyHtml: '<p>愿您在新的一岁里，心想事成、笑口常开，每一天都充满阳光与惊喜。</p>',
    closingHtml: '<p style="margin-top:16px">最美好的祝愿送给最特别的您 💐</p>',
  },
  {
    id: 'work',
    name: '工作通知',
    emoji: '📋',
    description: '会议、截止、事项提醒',
    defaultSubject: '【TimeMark】工作事项通知',
    greetingVariants: [
      { id: 'neutral', name: '标准通知', greetingHtml: '<p>{{contact_name}} 您好，</p><p>以下是与您相关的工作事项，请查收：</p>' },
      { id: 'urgent', name: '紧急提醒', greetingHtml: '<p>{{contact_name}} 您好，</p><p><strong>【重要】</strong> 请优先处理以下事项：</p>' },
      { id: 'meeting', name: '会议邀请', greetingHtml: '<p>{{contact_name}} 您好，</p><p>诚邀您参加以下会议/活动：</p>' },
      { id: 'deadline', name: '截止提醒', greetingHtml: '<p>{{contact_name}} 您好，</p><p>温馨提醒：以下事项即将到期，请及时处理：</p>' },
    ],
    bodyHtml: '<ul><li>事项一：（请在此填写具体内容）</li><li>事项二：（请在此填写具体时间/地点）</li></ul><p>如有疑问，请随时回复本邮件。</p>',
    closingHtml: '<p style="margin-top:16px">感谢您的配合！</p>',
  },
  {
    id: 'reminder',
    name: '温馨提醒',
    emoji: '🔔',
    description: '日程、健康、生活关怀',
    defaultSubject: '温馨提醒 · TimeMark',
    greetingVariants: [
      { id: 'gentle', name: '温柔关怀', greetingHtml: '<p>亲爱的 {{contact_name}}，</p><p>想轻轻提醒您：</p>' },
      { id: 'brief', name: '简洁直接', greetingHtml: '<p>{{contact_name}} 您好，</p><p>温馨提示：</p>' },
      { id: 'schedule', name: '日程提醒', greetingHtml: '<p>{{contact_name}} 您好，</p><p>您有以下日程即将到来：</p>' },
      { id: 'health', name: '健康关怀', greetingHtml: '<p>{{contact_name}} 您好，</p><p>天气转凉，请注意保暖，照顾好自己：</p>' },
    ],
    bodyHtml: '<p>（请在此填写具体提醒内容，如日期、事项、注意事项等）</p>',
    closingHtml: '<p style="margin-top:16px">愿您一切安好 🌸</p>',
  },
  {
    id: 'thanks',
    name: '感谢与跟进',
    emoji: '💌',
    description: '感谢信、回访、邀请',
    defaultSubject: '感谢您的支持',
    greetingVariants: [
      { id: 'thanks', name: '真诚感谢', greetingHtml: '<p>亲爱的 {{contact_name}}，</p><p>衷心感谢您的支持与信任！</p>' },
      { id: 'followup', name: '跟进回访', greetingHtml: '<p>{{contact_name}} 您好，</p><p>好久不见，特此来信跟进近况：</p>' },
      { id: 'invite', name: '活动邀请', greetingHtml: '<p>{{contact_name}} 您好，</p><p>诚挚邀请您参加：</p>' },
      { id: 'feedback', name: '征求意见', greetingHtml: '<p>{{contact_name}} 您好，</p><p>您的意见对我们非常重要，恳请您抽空反馈：</p>' },
    ],
    bodyHtml: '<p>（请在此填写感谢内容、活动详情或问卷链接等）</p>',
    closingHtml: '<p style="margin-top:16px">期待您的回复！</p>',
  },
  {
    id: 'notice',
    name: '系统通知',
    emoji: '📢',
    description: '通用通知、公告',
    defaultSubject: '系统通知 · TimeMark',
    greetingVariants: [
      { id: 'default', name: '通用', greetingHtml: '<p>{{contact_name}} 您好，</p><p>这是一条来自 TimeMark 的通知：</p>' },
      { id: 'update', name: '更新公告', greetingHtml: '<p>{{contact_name}} 您好，</p><p>我们有一些重要更新与您分享：</p>' },
      { id: 'account', name: '账户相关', greetingHtml: '<p>{{contact_name}} 您好，</p><p>关于您的账户/订阅，请注意以下信息：</p>' },
    ],
    bodyHtml: '<p>（请在此填写通知正文）</p>',
    closingHtml: '<p style="margin-top:16px">如有疑问，请联系管理员。</p>',
  },
];

/** 替换批量邮件变量 */
export function renderBroadcastTemplate(
  template: string,
  vars: { contact_name?: string; subject?: string },
): string {
  const contactName = vars.contact_name?.trim() || '您好';
  const map: Record<string, string> = {
    '{{contact_name}}': contactName,
    '{{name}}': contactName,
    '{{联系人}}': contactName,
    '{{subject}}': vars.subject || '',
    '{{主题}}': vars.subject || '',
  };
  let result = template;
  for (const [key, value] of Object.entries(map)) {
    result = result.split(key).join(value);
  }
  return result;
}

export function buildBroadcastEmail(
  category: BroadcastTemplateCategory,
  greetingVariantId: string,
  subjectOverride?: string,
): { subject: string; html: string } {
  const variant =
    category.greetingVariants.find((v) => v.id === greetingVariantId) ||
    category.greetingVariants[0];
  const subject = subjectOverride?.trim() || category.defaultSubject;
  const sampleName = '张三';
  const parts = [
    `<div style="font-family:sans-serif;line-height:1.7;color:#1e293b">`,
    renderBroadcastTemplate(variant.greetingHtml, { contact_name: sampleName, subject }),
    renderBroadcastTemplate(category.bodyHtml, { contact_name: sampleName, subject }),
    renderBroadcastTemplate(category.closingHtml, { contact_name: sampleName, subject }),
    `</div>`,
  ];
  return { subject, html: parts.join('\n') };
}

/** @deprecated 使用 BROADCAST_TEMPLATE_CATEGORIES */
export const BROADCAST_PRESET_TEMPLATES = BROADCAST_TEMPLATE_CATEGORIES.map((c) => ({
  id: c.id,
  name: c.name,
  content: buildBroadcastEmail(c, c.greetingVariants[0].id).html,
  isPreset: true as const,
  variables: ['{{contact_name}}', '{{name}}'],
  description: c.description,
}));
