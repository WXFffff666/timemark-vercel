import { Lunar, Solar } from 'lunar-javascript';

function solarToLunar(date) {
  const solar = Solar.fromYmdHms(
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    12, 0, 0
  );
  const lunar = solar.getLunar();
  const month = lunar.getMonth();
  return {
    year: lunar.getYear(),
    month: Math.abs(month),
    day: lunar.getDay(),
    isLeap: month < 0
  };
}

const testCases = [
  { date: '2024-02-10', expected: '2024年正月初一', desc: '2024春节' },
  { date: '2025-01-29', expected: '2025年正月初一', desc: '2025春节' },
  { date: '2023-03-22', expected: '2023年闰二月初一', desc: '2023闰二月' },
  { date: '2020-05-23', expected: '2020年闰四月初一', desc: '2020闰四月' },
  { date: '2024-06-10', expected: '2024年五月初五', desc: '2024端午' },
  { date: '2024-09-17', expected: '2024年八月十五', desc: '2024中秋' },
];

console.log('=== 农历转换测试 ===\n');

const months = ['正月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '冬月', '腊月'];
const days = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十'];

let passed = 0, failed = 0;

testCases.forEach(({ date, expected, desc }) => {
  const [year, month, day] = date.split('-').map(Number);
  const testDate = new Date(year, month - 1, day, 12, 0, 0);
  const result = solarToLunar(testDate);
  
  const monthStr = result.isLeap ? `闰${months[result.month - 1]}` : months[result.month - 1];
  const dayStr = days[result.day - 1];
  const actual = `${result.year}年${monthStr}${dayStr}`;
  
  if (actual === expected) {
    console.log(`✅ ${desc}: ${date} → ${actual}`);
    passed++;
  } else {
    console.log(`❌ ${desc}: ${date} → 期望 ${expected}, 实际 ${actual}`);
    failed++;
  }
});

console.log(`\n总计: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
