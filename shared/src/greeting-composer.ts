/**
 * 祝福组合引擎（v2.25）：无 AI 时的个性化生日祝福生成。
 *
 * 设计契约：
 * - **确定性**：同一 (contactId, year, 语料版本) 永远产出同一封——预演页所见即所发，
 *   cron 与 dry-run 复用同一函数。
 * - **不重文**：同一年内同一联系人的开头/主体/结尾由 djb2 哈希选定，跨年轮换；
 *   池子按 (开头 × 主体 × 结尾) 组合，个人空间远大于寿命年数。
 * - **零外发依赖**：纯函数，无网络、无 AI——cron 里 AI 网关不可用/未配置时的兜底路径。
 * - **个性化**：称呼按昵称>姓名；关系词映射进正文；备注有内容时加陪伴句。
 */

/** 生日祝福主体池（与 blessings.ts 的 birthday 池同一语料口径，此处偏完整句） */
const GREETING_BODIES: string[] = [
  '愿你新的一岁，所有的期待都能如约而至，所有的美好都能不期而遇。',
  '祝你生日快乐！愿你眼里有光，心中有爱，前路坦荡，岁岁平安。',
  '又长大一岁啦～愿你的快乐不止生日这一天，而是每一天。',
  '愿你的新一年：工作顺利不熬夜，身体健康不发愁，笑容常在不用愁。',
  '生日快乐！愿你被这个世界温柔以待，也继续做那个温暖别人的人。',
  '愿新的一岁里，你热爱的一切都热烈地回应你。',
  '祝你生日快乐，万事顺遂。愿时光对你温柔，未来对你敞开。',
  '愿你的每一个愿望都能实现，每一份努力都有回响。生日快乐！',
  '新的一岁，愿你保持热爱，奔赴山海，也记得好好照顾自己。',
  '生日快乐！愿你拥有的比想要的更多，失去的都不重要。',
  '愿岁月不改你的笑容，愿生活不负你的努力。生日快乐！',
  '祝你新的一岁：三餐四季，温柔有趣；不必太匆忙，也不必太逞强。',
  '愿你的生日像你一样特别，愿你的每一天都值得庆祝。',
  '生日快乐！愿新的一岁平安喜乐，得偿所愿，健健康康。',
];

/** 开头变体（按称呼占位） */
const GREETING_OPENERS: string[] = [
  '{name}，生日快乐！',
  '{name}，今天是属于你的日子！',
  '亲爱的{name}，生日快乐 🎂',
];

/** 结尾变体（署名占位 {owner}） */
const GREETING_CLOSINGS: string[] = [
  '——记得为我吃块蛋糕呀。{owner}',
  '——愿这一天你过得开心。{owner}',
  '——新的一岁也要好好的呀。{owner}',
];

/** 关系 → 个性化一句（有 relationship 时插入） */
const RELATIONSHIP_LINES: Record<string, string> = {
  家人: '家人是最长情的陪伴，谢谢你一直都在。',
  父母: '谢谢你为这个家的付出，新的一岁请多为自己而活。',
  朋友: '谢谢你总是那个能聊到一起的人，友谊长存。',
  同事: '谢谢你一路的照应与配合，合作愉快，也祝你生活精彩。',
  邻居: '谢谢你让邻里之间更有人情味。',
  伴侣: '谢谢你把平凡的日子过成了值得纪念的样子。',
};

/** 备注存在时加入的陪伴句 */
const NOTES_LINE = '另外，你备注里的小事我一直记着呢，新的一岁继续。';

function djb2(text: string): number {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return h >>> 0;
}

/** 确定性选取：同 seed 永远同一 index（纯函数，便于单测） */
export function pickVariant(pool: string[], seedText: string): string {
  if (pool.length === 0) return '';
  return pool[djb2(seedText) % pool.length]!;
}

/** 称呼解析：昵称 > 姓名（纯函数） */
export function resolveGreetingName(input: { name?: string | null; nickname?: string | null }): string {
  const nickname = (input.nickname ?? '').trim();
  if (nickname) return nickname;
  const name = (input.name ?? '').trim();
  return name || '朋友';
}

/** 关系词 → 个性化句（未映射的关系原样进"谢谢你作为我的{relationship}…"句式） */
export function relationshipLine(relationship?: string | null): string {
  const rel = (relationship ?? '').trim();
  if (!rel) return '';
  const mapped = RELATIONSHIP_LINES[rel];
  if (mapped) return mapped;
  if (rel.length > 20) return ''; // 异常长文本不进正文
  return `谢谢你作为我的${rel}，新的一岁也请多多关照。`;
}

export interface GreetingComposeInput {
  contactId: number;
  year: string;
  name?: string | null;
  nickname?: string | null;
  relationship?: string | null;
  notes?: string | null;
  /** 机主署名（机主用户名或"我"） */
  ownerSignature?: string;
  /** 生日日期行（可选；农历括注由调用方拼好） */
  dateLine?: string;
}

export interface ComposedGreeting {
  subject: string;
  greetingText: string;
  html: string;
}

/** 语料版本号：改语料/结构时 +1，让所有联系人在下一年重新轮换 */
const COMPOSER_VERSION = 1;

/**
 * 组合生日祝福（确定性、零依赖）。
 * 同一 (contactId, year) 永远同一封；跨年/语料变更时轮换。
 */
export function composeBirthdayGreeting(input: GreetingComposeInput): ComposedGreeting {
  const name = resolveGreetingName(input);
  const owner = (input.ownerSignature ?? '').trim() || '我';
  const seed = `${input.contactId}:${input.year}:v${COMPOSER_VERSION}`;

  const opener = pickVariant(GREETING_OPENERS, `${seed}:opener`).replaceAll('{name}', name);
  const body = pickVariant(GREETING_BODIES, `${seed}:body`);
  const closing = pickVariant(GREETING_CLOSINGS, `${seed}:closing`).replaceAll('{owner}', owner);
  const relLine = relationshipLine(input.relationship);
  const notesLine = (input.notes ?? '').trim().length > 0 ? NOTES_LINE : '';

  const paragraphs = [opener, body, relLine, notesLine, closing].filter((p) => p.length > 0);
  const greetingText = paragraphs.join('\n');

  const dateHtml = input.dateLine ? `<p style="color:#64748b;font-size:13px;margin:0 0 12px">${input.dateLine}</p>` : '';
  const bodyHtml = paragraphs
    .map((p) => `<p style="margin:0 0 14px;line-height:1.8">${p}</p>`)
    .join('');
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;max-width:560px;margin:0 auto;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">',
    '<div style="background:linear-gradient(135deg,#fda4af,#f472b6);padding:28px 24px;text-align:center">',
    '<p style="margin:0;font-size:28px">🎂</p>',
    `<p style="margin:6px 0 0;font-size:18px;font-weight:600;color:#fff">${name}，生日快乐</p>`,
    '</div>',
    `<div style="padding:24px;background:#fff;color:#1e293b;font-size:15px">`,
    dateHtml,
    bodyHtml,
    '</div>',
    '</div>',
  ].join('\n');

  return { subject: `${name}，生日快乐 🎂`, greetingText, html };
}
