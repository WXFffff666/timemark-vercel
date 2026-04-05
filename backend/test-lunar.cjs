const { Lunar, Solar } = require('lunar-javascript');

console.log('=== 测试 lunar-javascript 农历转换准确性 ===\n');

// 测试用例：公历日期 -> 农历转换
const solarTestCases = [
  // 常规日期
  { solar: '2024-01-01', desc: '元旦' },
  { solar: '2024-02-10', desc: '春节' },
  { solar: '2024-06-10', desc: '端午节' },
  { solar: '2024-09-17', desc: '中秋节' },
  { solar: '2024-10-01', desc: '国庆' },
  { solar: '2025-01-01', desc: '元旦跨年' },
  // 闰月测试
  { solar: '2023-06-18', desc: '非闰五月后' },
  { solar: '2023-07-17', desc: '闰五月后六月' },
  // 特殊日期
  { solar: '2000-01-01', desc: '千禧年' },
  { solar: '2008-08-08', desc: '北京奥运开幕式' },
  { solar: '2022-02-01', desc: '2022春节' },
  { solar: '2023-01-22', desc: '2023春节' },
  { solar: '2024-02-10', desc: '2024春节' },
  { solar: '2025-01-29', desc: '2025春节' },
  { solar: '2026-02-17', desc: '2026春节' },
  { solar: '2027-02-06', desc: '2027春节' },
  { solar: '2028-01-26', desc: '2028春节' },
  { solar: '2029-02-13', desc: '2029春节' },
  { solar: '2030-02-03', desc: '2030春节' },
  { solar: '2024-03-20', desc: '春分附近' },
  { solar: '2024-04-20', desc: '谷雨' },
  { solar: '2024-05-20', desc: '小满' },
  { solar: '2024-07-22', desc: '大暑' },
  { solar: '2024-08-19', desc: '处暑' },
  { solar: '2024-09-07', desc: '白露' },
  { solar: '2024-10-23', desc: '霜降' },
];

let passed = 0;
let failed = 0;

console.log('=== 公历 -> 农历 测试 ===\n');

solarTestCases.forEach(({solar, desc}) => {
  const [year, month, day] = solar.split('-').map(Number);
  const solarObj = Solar.fromYmd(year, month, day);
  const lunar = solarObj.getLunar();
  
  const monthNames = ['正','二','三','四','五','六','七','八','九','十','十一','十二'];
  const monthName = monthNames[lunar.getMonth() - 1] || `未知${lunar.getMonth()}`;
  const lunarStr = `${lunar.getYear()}-${monthName}-${lunar.getDay()}`;
  const isLeap = lunar.getMonth() < 0; // 闰月为负数
  
  console.log(`${solar} (${desc}) -> ${lunarStr}${isLeap ? '(闰月)' : ''} ✓`);
  passed++;
});

console.log(`\n公历->农历: ${passed}/${solarTestCases.length} 通过\n`);

console.log('=== 农历 -> 公历 测试 ===\n');
passed = 0;
failed = 0;

const lunarTestCases = [
  // 春节系列
  { lunar: {year: 2024, month: 1, day: 1}, expected: '2024-02-10', desc: '2024春节' },
  { lunar: {year: 2025, month: 1, day: 1}, expected: '2025-01-29', desc: '2025春节' },
  { lunar: {year: 2026, month: 1, day: 1}, expected: '2026-02-17', desc: '2026春节' },
  { lunar: {year: 2023, month: 1, day: 1}, expected: '2023-01-22', desc: '2023春节' },
  { lunar: {year: 2022, month: 1, day: 1}, expected: '2022-02-01', desc: '2022春节' },
  { lunar: {year: 2021, month: 1, day: 1}, expected: '2021-02-12', desc: '2021春节' },
  { lunar: {year: 2020, month: 1, day: 1}, expected: '2020-01-25', desc: '2020春节' },
  { lunar: {year: 2019, month: 1, day: 1}, expected: '2019-02-05', desc: '2019春节' },
  { lunar: {year: 2018, month: 1, day: 1}, expected: '2018-02-16', desc: '2018春节' },
  { lunar: {year: 2017, month: 1, day: 1}, expected: '2017-01-28', desc: '2017春节' },
  // 节日
  { lunar: {year: 2024, month: 5, day: 5}, expected: '2024-06-10', desc: '端午' },
  { lunar: {year: 2024, month: 8, day: 15}, expected: '2024-09-17', desc: '中秋' },
  { lunar: {year: 2024, month: 1, day: 15}, expected: '2024-02-24', desc: '元宵' },
  { lunar: {year: 2024, month: 7, day: 7}, expected: '2024-08-09', desc: '七夕' },
  { lunar: {year: 2024, month: 9, day: 9}, expected: '2024-10-11', desc: '重阳' },
  // 常规
  { lunar: {year: 2024, month: 3, day: 3}, expected: '2024-04-11', desc: '常规' },
  { lunar: {year: 2024, month: 6, day: 6}, expected: '2024-07-11', desc: '常规' },
  { lunar: {year: 2024, month: 12, day: 20}, expected: '2025-01-19', desc: '年底' },
  // 跨年
  { lunar: {year: 2024, month: 12, day: 30}, expected: '2025-01-28', desc: '年前' },
  { lunar: {year: 2025, month: 1, day: 1}, expected: '2025-01-29', desc: '新年' },
  // 历史日期
  { lunar: {year: 2000, month: 1, day: 1}, expected: '2000-02-05', desc: '千禧年' },
  { lunar: {year: 2010, month: 1, day: 1}, expected: '2010-02-14', desc: '2010春节' },
  { lunar: {year: 2020, month: 1, day: 1}, expected: '2020-01-25', desc: '2020春节' },
  // 闰月 - 2012 闰四月
  { lunar: {year: 2012, month: 4, day: 1}, expected: '2012-05-21', desc: '闰四月' },
  { lunar: {year: 2012, month: 5, day: 1}, expected: '2012-06-19', desc: '闰四月后五月' },
  // 闰月 - 2023 闰二月
  { lunar: {year: 2023, month: 2, day: 1}, expected: '2023-03-22', desc: '闰二月' },
  { lunar: {year: 2023, month: 3, day: 1}, expected: '2023-04-20', desc: '闰二月后三月' },
  // 闰月 - 2020 闰四月
  { lunar: {year: 2020, month: 4, day: 1}, expected: '2020-05-23', desc: '闰四月' },
  { lunar: {year: 2020, month: 5, day: 1}, expected: '2020-06-21', desc: '闰四月后五月' },
  // 闰月 - 2017 闰六月
  { lunar: {year: 2017, month: 6, day: 1}, expected: '2017-07-23', desc: '闰六月' },
  { lunar: {year: 2017, month: 7, day: 1}, expected: '2017-08-21', desc: '闰六月后七月' },
  // 闰月 - 2014 闰九月
  { lunar: {year: 2014, month: 9, day: 1}, expected: '2014-10-24', desc: '闰九月' },
  { lunar: {year: 2014, month: 10, day: 1}, expected: '2014-11-22', desc: '闰九月后十月' },
  // 闰月 - 2006 闰七月
  { lunar: {year: 2006, month: 7, day: 1}, expected: '2006-08-24', desc: '闰七月' },
  { lunar: {year: 2006, month: 8, day: 1}, expected: '2006-09-22', desc: '闰七月后八月' },
  // 边界测试
  { lunar: {year: 1900, month: 1, day: 1}, expected: '1900-02-20', desc: '清末' },
  { lunar: {year: 1950, month: 1, day: 1}, expected: '1950-02-17', desc: '建国初' },
  { lunar: {year: 1984, month: 1, day: 1}, expected: '1984-02-02', desc: '84春节' },
  { lunar: {year: 1997, month: 1, day: 1}, expected: '1997-02-07', desc: '97春节' },
];

lunarTestCases.forEach(({lunar, expected, desc}) => {
  try {
    const lunarObj = Lunar.fromYmd(lunar.year, lunar.month, lunar.day);
    const solar = lunarObj.getSolar();
    const solarStr = `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`;
    
    const success = solarStr === expected;
    console.log(`农历${lunar.year}-${lunar.month}-${lunar.day} (${desc}) -> ${solarStr} ${success ? '✓' : '✗ 期望: ' + expected}`);
    if (success) passed++; else failed++;
  } catch (e) {
    console.log(`农历${lunar.year}-${lunar.month}-${lunar.day} -> 错误: ${e.message} ✗`);
    failed++;
  }
});

console.log(`\n农历->公历: ${passed}/${lunarTestCases.length} 通过`);

if (failed > 0) {
  console.log(`\n⚠️  有 ${failed} 个测试失败！`);
  process.exit(1);
} else {
  console.log('\n✅ 所有测试通过！');
  process.exit(0);
}
