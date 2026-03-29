import { solarToLunar, lunarToSolar, formatLunarDate } from '../lib/lunar';

const testCases = [
  { solar: '2024-01-01', lunar: { year: 2023, month: 11, day: 20, isLeap: false }, desc: '元旦' },
  { solar: '2024-02-10', lunar: { year: 2024, month: 1, day: 1, isLeap: false }, desc: '春节' },
  { solar: '2024-02-24', lunar: { year: 2024, month: 1, day: 15, isLeap: false }, desc: '元宵节' },
  { solar: '2024-04-04', lunar: { year: 2024, month: 2, day: 26, isLeap: false }, desc: '清明' },
  { solar: '2024-05-01', lunar: { year: 2024, month: 3, day: 23, isLeap: false }, desc: '劳动节' },
  { solar: '2024-06-10', lunar: { year: 2024, month: 5, day: 5, isLeap: false }, desc: '端午节' },
  { solar: '2024-08-10', lunar: { year: 2024, month: 7, day: 7, isLeap: false }, desc: '七夕' },
  { solar: '2024-09-17', lunar: { year: 2024, month: 8, day: 15, isLeap: false }, desc: '中秋节' },
  { solar: '2024-10-01', lunar: { year: 2024, month: 8, day: 29, isLeap: false }, desc: '国庆节' },
  { solar: '2024-10-11', lunar: { year: 2024, month: 9, day: 9, isLeap: false }, desc: '重阳节' },
  { solar: '2025-01-29', lunar: { year: 2025, month: 1, day: 1, isLeap: false }, desc: '2025春节' },
  { solar: '2025-02-12', lunar: { year: 2025, month: 1, day: 15, isLeap: false }, desc: '2025元宵' },
  { solar: '2025-05-31', lunar: { year: 2025, month: 5, day: 5, isLeap: false }, desc: '2025端午' },
  { solar: '2025-10-06', lunar: { year: 2025, month: 9, day: 14, isLeap: false }, desc: '2025中秋' },
  { solar: '2026-02-17', lunar: { year: 2026, month: 1, day: 1, isLeap: false }, desc: '2026春节' },
];

console.log('=== 农历转换测试 ===\n');

let passCount = 0;
let failCount = 0;

testCases.forEach((tc, idx) => {
  const [y, m, d] = tc.solar.split('-').map(Number);
  const solarDate = new Date(y, m - 1, d, 12, 0, 0);
  
  // 公历转农历
  const result = solarToLunar(solarDate);
  const match = result.year === tc.lunar.year && 
                result.month === tc.lunar.month && 
                result.day === tc.lunar.day &&
                result.isLeap === tc.lunar.isLeap;
  
  if (match) {
    passCount++;
    console.log(`✓ ${idx + 1}. ${tc.desc} (${tc.solar})`);
    console.log(`   农历: ${formatLunarDate(result)}`);
  } else {
    failCount++;
    console.log(`✗ ${idx + 1}. ${tc.desc} (${tc.solar})`);
    console.log(`   期望: ${tc.lunar.year}-${tc.lunar.month}-${tc.lunar.day}`);
    console.log(`   实际: ${result.year}-${result.month}-${result.day}`);
  }
  
  // 农历转公历
  const backToSolar = lunarToSolar(tc.lunar);
  const solarMatch = backToSolar.getFullYear() === y && 
                     backToSolar.getMonth() === m - 1 && 
                     backToSolar.getDate() === d;
  
  if (!solarMatch) {
    console.log(`   ⚠ 反向转换失败: ${backToSolar.toISOString().split('T')[0]}`);
  }
  console.log('');
});

console.log(`\n总计: ${testCases.length} 个测试`);
console.log(`通过: ${passCount} | 失败: ${failCount}`);
console.log(`成功率: ${(passCount / testCases.length * 100).toFixed(1)}%`);
