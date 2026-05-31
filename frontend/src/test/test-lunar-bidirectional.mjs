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
  { 
    solar: '2024-02-10', 
    lunar: { year: 2024, month: 1, day: 1, isLeap: false },
    desc: '2024春节'
  },
  { 
    solar: '2023-03-22', 
    lunar: { year: 2023, month: 2, day: 1, isLeap: true },
    desc: '2023闰二月初一'
  },
  { 
    solar: '2024-06-10', 
    lunar: { year: 2024, month: 5, day: 5, isLeap: false },
    desc: '2024端午'
  },
];

console.log('=== 双向转换测试 ===\n');

let passed = 0, failed = 0;

testCases.forEach(({ solar, lunar, desc }) => {
  // 测试1: 公历 → 农历
  const [year, month, day] = solar.split('-').map(Number);
  const solarDate = new Date(year, month - 1, day, 12, 0, 0);
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
    console.log(`   公历→农历: ${solar} → ${lunar.year}年${lunar.month}月${lunar.day}日`);
    console.log(`   农历→公历: ${lunar.year}年${lunar.month}月${lunar.day}日 → ${solar}`);
    passed++;
  } else {
    console.log(`❌ ${desc}`);
    if (!match1) console.log(`   公历→农历失败`);
    if (!match2) console.log(`   农历→公历失败: 期望${solar}, 实际${result2.toISOString().split('T')[0]}`);
    failed++;
  }
  console.log();
});

console.log(`总计: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
