/**
 * 关系映射工具
 * 用于根据收件人身份转换事件称呼
 * 例如："我妈" → "妻子"
 */

export interface RelationshipMappingRow {
  id: number;
  user_id: number;
  event_id: number;
  from_relation: string;
  to_relation: string;
  recipient_email?: string;
  recipient_type?: string;
}

/**
 * 应用关系映射
 * @param eventName 原始事件名称
 * @param mappings 关系映射列表
 * @param recipientEmail 收件人邮箱（可选）
 * @param recipientType 收件人类型（可选）
 * @returns 转换后的事件名称
 */
export function applyRelationshipMapping(
  eventName: string,
  mappings: RelationshipMappingRow[],
  recipientEmail?: string,
  recipientType?: string
): string {
  if (!mappings || mappings.length === 0) {
    return eventName;
  }

  // 优先通过收件人类型匹配
  if (recipientType) {
    const typeMapping = mappings.find(m => m.recipient_type === recipientType);
    if (typeMapping) {
      return eventName.replaceAll(typeMapping.from_relation, typeMapping.to_relation);
    }
  }

  // 其次通过收件人邮箱匹配
  if (recipientEmail) {
    const emailMapping = mappings.find(m => m.recipient_email === recipientEmail);
    if (emailMapping) {
      return eventName.replaceAll(emailMapping.from_relation, emailMapping.to_relation);
    }
  }

  // 最后尝试模糊匹配（检查事件名称是否包含原始称呼）
  for (const mapping of mappings) {
    if (eventName.includes(mapping.from_relation)) {
      return eventName.replaceAll(mapping.from_relation, mapping.to_relation);
    }
  }

  return eventName;
}

/**
 * 预设的关系类型
 */
export const PRESET_RELATIONS = [
  { value: 'me', label: '我本人' },
  { value: 'father', label: '父亲' },
  { value: 'mother', label: '母亲' },
  { value: 'wife', label: '妻子' },
  { value: 'husband', label: '丈夫' },
  { value: 'son', label: '儿子' },
  { value: 'daughter', label: '女儿' },
  { value: 'brother', label: '兄弟' },
  { value: 'sister', label: '姐妹' },
  { value: 'friend', label: '朋友' },
  { value: 'colleague', label: '同事' },
];

/**
 * 常用称呼映射建议
 * 
 * 使用场景：
 * - 当被提醒人是"我爸"，提醒人是"我"时，通知内容会说"父亲的生日"
 * - 当被提醒人是"老婆"，提醒人是"我"时，通知内容会说"妻子的生日"
 */
export const COMMON_RELATIONS = [
  // 父母
  { from: '我爸', to: '父亲' },
  { from: '我妈', to: '母亲' },
  { from: '爸爸', to: '父亲' },
  { from: '妈妈', to: '母亲' },
  { from: '爹', to: '父亲' },
  { from: '娘', to: '母亲' },
  
  // 配偶
  { from: '老婆', to: '妻子' },
  { from: '老公', to: '丈夫' },
  { from: '媳妇', to: '妻子' },
  { from: '太太', to: '妻子' },
  
  // 子女
  { from: '儿子', to: '孩子' },
  { from: '女儿', to: '孩子' },
  { from: '宝贝', to: '孩子' },
  { from: '宝宝', to: '孩子' },
  
  // 兄弟姐妹
  { from: '弟弟', to: '兄弟' },
  { from: '哥哥', to: '兄弟' },
  { from: '妹妹', to: '姐妹' },
  { from: '姐姐', to: '姐妹' },
  
  // 祖父母
  { from: '爷爷', to: '祖父' },
  { from: '奶奶', to: '祖母' },
  { from: '外公', to: '外祖父' },
  { from: '外婆', to: '外祖母' },
  { from: '姥爷', to: '外祖父' },
  { from: '姥姥', to: '外祖母' },
  
  // 其他亲属
  { from: '叔叔', to: '叔叔' },
  { from: '阿姨', to: '阿姨' },
  { from: '舅舅', to: '舅舅' },
  { from: '姑姑', to: '姑姑' },
  { from: '侄子', to: '侄子' },
  { from: '侄女', to: '侄女' },
  { from: '外甥', to: '外甥' },
  { from: '外甥女', to: '外甥女' },
  
  // 朋友同事
  { from: '闺蜜', to: '好友' },
  { from: '兄弟', to: '好友' },
  { from: '同事', to: '同事' },
  { from: '同学', to: '同学' },
];
