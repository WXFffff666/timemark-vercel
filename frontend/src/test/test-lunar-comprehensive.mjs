import { Lunar, Solar } from 'lunar-javascript';

// 公历转农历
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

// 农历转公历
function lunarToSolar(lunar) {
  const month = lunar.isLeap ? -lunar.month : lunar.month;
  const lunarDate = Lunar.fromYmd(lunar.year, month, lunar.day);
  const solar = lunarDate.getSolar();
  return new Date(solar.getYear(), solar.getMonth() - 1, solar.getDay(), 12, 0, 0);
}

const testCases = [
  // 春节（正月初一）
  { solar: '2024-02-10', lunar: { year: 2024, month: 1, day: 1, isLeap: false }, desc: '2024春节' },
  { solar: '2025-01-29', lunar: { year: 2025, month: 1, day: 1, isLeap: false }, desc: '2025春节' },
  { solar: '2026-02-17', lunar: { year: 2026, month: 1, day: 1, isLeap: false }, desc: '2026春节' },
  
  // 闰月
  { solar: '2023-03-22', lunar: { year: 2023, month: 2, day: 1, isLeap: true }, desc: '2023闰二月初一' },
  { solar: '2023-04-19', lunar: { year: 2023, month: 2, day: 29, isLeap: true }, desc: '2023闰二月廿九' },
  { solar: '2020-05-23', lunar: { year: 2020, month: 4, day: 1, isLeap: true }, desc: '2020闰四月初一' },
  { solar: '2020-06-20', lunar: { year: 2020, month: 4, day: 29, isLeap: true }, desc: '2020闰四月廿九' },
  
  // 传统节日
  { solar: '2024-06-10', lunar: { year: 2024, month: 5, day: 5, isLeap: false }, desc: '2024端午' },
  { solar: '2024-09-17', lunar: { year: 2024, month: 8, day: 15, isLeap: false }, desc: '2024中秋' },
  { solar: '2024-10-11', lunar: { year: 2024, month: 9, day: 9, isLeap: false }, desc: '2024重阳' },
  
  // 月末月初边界
  { solar: '2024-03-10', lunar: { year: 2024, month: 2, day: 1, isLeap: false }, desc: '2024二月初一' },
  { solar: '2024-04-08', lunar: { year: 2024, month: 2, day: 30, isLeap: false }, desc: '2024二月三十' },
  
  // 年末年初
  { solar: '2023-12-31', lunar: { year: 2023, month: 11, day: 19, isLeap: false }, desc: '2023年末' },
  { solar: '2024-12-31', lunar: { year: 2024, month: 12, day: 1, isLeap: false }, desc: '2024年末' },
  
  // 普通日期
  { solar: '2024-05-15', lunar: { year: 2024, month: 4, day: 8, isLeap: false }, desc: '2024年5月中旬' },
  { solar: '2024-07-20', lunar: { year: 2024, month: 6, day: 15, isLeap: false }, desc: '2024年7月中旬' },
];

console.log('=== 公历农历双向转换综合测试 ===\n');

let passed = 0, failed = 0;

testCases.forEach(({ solar, lunar, desc }) => {
  const [year, month, day] = solar.split('-').map(Number);
  const solarDate = new Date(year, month - 1, day, 12, 0, 0);
  
  // 测试1: 公历 → 农历
  const result1 = solarToLunar(solarDate);
  const match1 = result1.year === lunar.year && 
                 result1.month === lunar.month && 
                 result1.day === lunar.day &&
                 result1.isLeap === lunar.isLeap;
  
  // 测试2: 农历 → 公历
  const result2 = lunarToSolar(lunar);
  const match2 = result2.getFullYear() === year &&
                 result2.getMonth() + 1 === month &&
                 result2.getDate() === day;
  
  if (match1 && match2) {
    console.log(`✅ ${desc}`);
    passed++;
  } else {
    console.log(`❌ ${desc}`);
    if (!match1) {
      console.log(`   公历→农历失败: 期望 ${lunar.year}年${lunar.isLeap?'闰':''}${lunar.month}月${lunar.day}日`);
      console.log(`   实际: ${result1.year}年${result1.isLeap?'闰':''}${result1.month}月${result1.day}日`);
    }
    if (!match2) {
      console.log(`   农历→公历失败: 期望 ${solar}, 实际 ${result2.toISOString().split('T')[0]}`);
    }
    failed++;
  }
});

console.log(`\n总计: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
