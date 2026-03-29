export const blessings = {
  birthday: [
    '福如东海，寿比南山',
    '生日快乐，健康长寿',
    '年年有今日，岁岁有今朝',
  ],
  anniversary: [
    '百年好合，永结同心',
    '白头偕老，幸福美满',
    '恩爱如初，相伴一生',
  ],
  exam: [
    '金榜题名，前程似锦',
    '旗开得胜，马到成功',
    '考试顺利，梦想成真',
  ],
  holiday: [
    '节日快乐，阖家欢乐',
    '万事如意，心想事成',
    '吉祥如意，幸福安康',
  ],
  other: [
    '心想事成，万事如意',
    '一切顺利，好运连连',
    '平安喜乐，岁岁平安',
  ],
};

export function getBlessing(type: string): string {
  const list = blessings[type as keyof typeof blessings] || blessings.other;
  return list[Math.floor(Math.random() * list.length)];
}
