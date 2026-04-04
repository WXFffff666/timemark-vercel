/**
 * 关系映射工具
 * 用于根据收件人身份转换事件称呼
 * 例如："我妈" → "妻子"
 */

export interface RelationshipMapping {
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
  mappings: RelationshipMapping[],
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
      return eventName.replace(typeMapping.from_relation, typeMapping.to_relation);
    }
  }

  // 其次通过收件人邮箱匹配
  if (recipientEmail) {
    const emailMapping = mappings.find(m => m.recipient_email === recipientEmail);
    if (emailMapping) {
      return eventName.replace(emailMapping.from_relation, emailMapping.to_relation);
    }
  }

  // 最后尝试模糊匹配（检查事件名称是否包含原始称呼）
  for (const mapping of mappings) {
    if (eventName.includes(mapping.from_relation)) {
      return eventName.replace(mapping.from_relation, mapping.to_relation);
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
 */
export const COMMON_RELATIONS = [
  { from: '我爸', to: '父亲' },
  { from: '我妈', to: '母亲' },
  { from: '老婆', to: '妻子' },
  { from: '老公', to: '丈夫' },
  { from: '儿子', to: '孩子' },
  { from: '女儿', to: '孩子' },
  { from: '弟弟', to: '兄弟' },
  { from: '哥哥', to: '兄弟' },
  { from: '妹妹', to: '姐妹' },
  { from: '姐姐', to: '姐妹' },
];
