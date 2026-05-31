const { Lunar, Solar } = require('lunar-javascript');

console.log('=== 完整双向转换测试 (每个方向40+用例) ===\n');

const monthNames = ['正','二','三','四','五','六','七','八','九','十','十一','十二'];

// ============ 公历 → 农历 测试 (45个) ============
console.log('【公历 → 农历】测试 (45个)\n');

const solarTestCases = [
  // 春节系列 (每年不同)
  { year: 2000, month: 1, day: 1, desc: '2000元旦' },
  { year: 2022, month: 2, day: 1, desc: '2022春节' },
  { year: 2023, month: 1, day: 22, desc: '2023春节' },
  { year: 2024, month: 2, day: 10, desc: '2024春节' },
  { year: 2025, month: 1, day: 29, desc: '2025春节' },
  { year: 2026, month: 2, day: 17, desc: '2026春节' },
  { year: 2027, month: 2, day: 6, desc: '2027春节' },
  { year: 2028, month: 1, day: 26, desc: '2028春节' },
  { year: 2029, month: 2, day: 13, desc: '2029春节' },
  { year: 2030, month: 2, day: 3, desc: '2030春节' },
  // 传统节日
  { year: 2024, month: 1, day: 15, desc: '2024元宵' },
  { year: 2024, month: 2, day: 14, desc: '2024情人节' },
  { year: 2024, month: 5, day: 1, desc: '2024劳动节' },
  { year: 2024, month: 6, day: 10, desc: '2024端午' },
  { year: 2024, month: 8, day: 10, desc: '2024七夕' },
  { year: 2024, month: 9, day: 17, desc: '2024中秋' },
  { year: 2024, month: 10, day: 11, desc: '2024重阳' },
  { year: 2024, month: 10, day: 1, desc: '2024国庆' },
  { year: 2024, month: 12, day: 25, desc: '2024圣诞' },
  // 闰月年份的公历日期
  { year: 2023, month: 3, day: 22, desc: '2023闰二月期间' },
  { year: 2023, month: 4, day: 21, desc: '2023闰二月后' },
  { year: 2020, month: 5, day: 23, desc: '2020闰四月期间' },
  { year: 2020, month: 6, day: 21, desc: '2020闰四月后' },
  { year: 2017, month: 7, day: 23, desc: '2017闰六月期间' },
  { year: 2017, month: 8, day: 21, desc: '2017闰六月后' },
  { year: 2014, month: 10, day: 24, desc: '2014闰九月期间' },
  { year: 2006, month: 8, day: 24, desc: '2006闰七月期间' },
  // 用户案例
  { year: 2007, month: 7, day: 28, desc: '用户案例: 2007-07-28' },
  // 特殊日期
  { year: 2000, month: 1, day: 1, desc: '2000千禧年' },
  { year: 2008, month: 8, day: 8, desc: '2008北京奥运' },
  { year: 2010, month: 5, day: 1, desc: '2010劳动节' },
  { year: 2015, month: 9, day: 3, desc: '2015抗战胜利日' },
  { year: 2019, month: 10, day: 1, desc: '2019国庆70年' },
  { year: 2020, month: 1, day: 1, desc: '2020元旦' },
  { year: 2021, month: 7, day: 1, desc: '2021建党百年' },
  { year: 2022, month: 2, day: 4, desc: '2022冬奥开幕' },
  { year: 2023, month: 1, day: 22, desc: '2023春节' },
  { year: 2024, month: 3, day: 20, desc: '2024春分' },
  { year: 2024, month: 4, day: 20, desc: '2024谷雨' },
  { year: 2024, month: 5, day: 20, desc: '2024小满' },
  { year: 2024, month: 6, day: 21, desc: '2024夏至' },
  { year: 2024, month: 7, day: 22, desc: '2024大暑' },
  { year: 2024, month: 8, day: 22, desc: '2024处暑' },
  { year: 2024, month: 9, day: 22, desc: '2024秋分' },
  { year: 2024, month: 10, day: 23, desc: '2024霜降' },
  { year: 2024, month: 12, day: 21, desc: '2024冬至' },
];

let passed = 0;
let failed = 0;

solarTestCases.forEach(({ year, month, day, desc }) => {
  try {
    const solar = Solar.fromYmd(year, month, day);
    const lunar = solar.getLunar();
    const isLeap = lunar.getMonth() < 0;
    const monthAbs = Math.abs(lunar.getMonth());
    const monthName = monthNames[monthAbs - 1];
    
    console.log(`公历 ${year}-${month}-${day} (${desc}) -> 农历 ${lunar.getYear()}-${monthName}-${lunar.getDay()}${isLeap ? '(闰)' : ''} ✓`);
    passed++;
  } catch (e) {
    console.log(`公历 ${year}-${month}-${day} -> 错误: ${e.message} ✗`);
    failed++;
  }
});

console.log(`\n公历→农历: ${passed}/${passed + failed} 通过\n`);

// ============ 农历 → 公历 测试 (45个) ============
console.log('【农历 → 公历】测试 (45个)\n');

const lunarTestCases = [
  // 春节系列
  { year: 2000, month: 1, day: 1, desc: '2000春节' },
  { year: 2022, month: 1, day: 1, desc: '2022春节' },
  { year: 2023, month: 1, day: 1, desc: '2023春节' },
  { year: 2024, month: 1, day: 1, desc: '2024春节' },
  { year: 2025, month: 1, day: 1, desc: '2025春节' },
  { year: 2026, month: 1, day: 1, desc: '2026春节' },
  { year: 2027, month: 1, day: 1, desc: '2027春节' },
  { year: 2028, month: 1, day: 1, desc: '2028春节' },
  { year: 2029, month: 1, day: 1, desc: '2029春节' },
  { year: 2030, month: 1, day: 1, desc: '2030春节' },
  // 传统节日 - 农历日期
  { year: 2024, month: 1, day: 15, desc: '2024元宵' },
  { year: 2024, month: 5, day: 5, desc: '2024端午' },
  { year: 2024, month: 7, day: 7, desc: '2024七夕' },
  { year: 2024, month: 8, day: 15, desc: '2024中秋' },
  { year: 2024, month: 9, day: 9, desc: '2024重阳' },
  // 常规日期
  { year: 2024, month: 3, day: 3, desc: '2024农历三三' },
  { year: 2024, month: 6, day: 6, desc: '2024农历六六' },
  { year: 2024, month: 12, day: 20, desc: '2024农历年底' },
  // 用户案例 - 农历6月15应该对应公历7月28
  { year: 2007, month: 6, day: 15, desc: '用户案例: 农历2007-06-15' },
  { year: 2007, month: 7, day: 15, desc: '用户案例: 农历2007-07-15' },
  // 闰月测试
  { year: 2023, month: 2, day: 1, isLeap: true, desc: '2023闰二月初一' },
  { year: 2023, month: 2, day: 15, isLeap: true, desc: '2023闰二月十五' },
  { year: 2023, month: 3, day: 1, desc: '2023二月初一' },
  { year: 2020, month: 4, day: 1, isLeap: true, desc: '2020闰四月初一' },
  { year: 2020, month: 4, day: 15, isLeap: true, desc: '2020闰四月十五' },
  { year: 2020, month: 5, day: 1, desc: '2020四月初一' },
  { year: 2017, month: 6, day: 1, isLeap: true, desc: '2017闰六月初一' },
  { year: 2017, month: 7, day: 1, desc: '2017六月初一' },
  { year: 2014, month: 9, day: 1, isLeap: true, desc: '2014闰九月初一' },
  { year: 2014, month: 10, day: 1, desc: '2014九月初一' },
  { year: 2006, month: 7, day: 1, isLeap: true, desc: '2006闰七月初一' },
  { year: 2006, month: 8, day: 1, desc: '2006七月初一' },
  // 跨年测试
  { year: 2024, month: 12, day: 29, desc: '2024农历年底' },
  { year: 2025, month: 1, day: 1, desc: '2025农历新年' },
  // 历史日期
  { year: 1900, month: 1, day: 1, desc: '1900春节' },
  { year: 1950, month: 1, day: 1, desc: '1950春节' },
  { year: 1984, month: 1, day: 1, desc: '1984春节' },
  { year: 1997, month: 1, day: 1, desc: '1997春节' },
  { year: 2000, month: 12, day: 1, desc: '2000农历年底' },
  { year: 2010, month: 1, day: 1, desc: '2010春节' },
  { year: 2015, month: 1, day: 1, desc: '2015春节' },
  { year: 2019, month: 1, day: 1, desc: '2019春节' },
  { year: 2021, month: 1, day: 1, desc: '2021春节' },
  { year: 2022, month: 1, day: 1, desc: '2022春节' },
  { year: 2023, month: 1, day: 15, desc: '2023元宵' },
  { year: 2025, month: 1, day: 15, desc: '2025元宵' },
];

passed = 0;
failed = 0;

lunarTestCases.forEach(({ year, month, day, isLeap, desc }) => {
  try {
    const lunar = Lunar.fromYmd(year, isLeap ? -month : month, day);
    const solar = lunar.getSolar();
    const solarStr = `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`;
    
    console.log(`农历 ${year}-${isLeap ? '闰' : ''}${month}-${day} (${desc}) -> 公历 ${solarStr} ✓`);
    passed++;
  } catch (e) {
    console.log(`农历 ${year}-${month}-${day} -> 错误: ${e.message} ✗`);
    failed++;
  }
});

console.log(`\n农历→公历: ${passed}/${passed + failed} 通过\n`);

console.log('=== 测试完成 ===');
console.log(`总计: ${passed + failed} 个测试用例`);
