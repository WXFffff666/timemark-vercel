const { Lunar, Solar } = require('lunar-javascript');

console.log('=== 测试农历转换问题 ===\n');

// 案例1: 公历2007-07-28 -> 农历
const solar1 = Solar.fromYmd(2007, 7, 28);
const lunar1 = solar1.getLunar();
console.log('案例1: 公历 2007-07-28 -> 农历');
console.log('  结果:', lunar1.getYear(), '年', Math.abs(lunar1.getMonth()), '月', lunar1.getDay(), '日', lunar1.getMonth() < 0 ? '(闰月)' : '');

// 案例2: 农历2007-6-15 -> 公历
const lunar2 = Lunar.fromYmd(2007, 6, 15);
const solar2 = lunar2.getSolar();
console.log('案例2: 农历 2007-6-15 -> 公历');
console.log('  结果:', solar2.getYear(), '-', String(solar2.getMonth()).padStart(2,'0'), '-', String(solar2.getDay()).padStart(2,'0'));

// 更多测试
console.log('\n=== 更多测试 ===');
const testCases = [
  { year: 2007, month: 7, day: 28, type: 'solar' },
  { year: 2007, month: 6, day: 15, type: 'lunar' },
  { year: 2024, month: 2, day: 10, type: 'solar' },
  { year: 2024, month: 1, day: 1, type: 'lunar' },
  { year: 2007, month: 7, day: 15, type: 'lunar' }, // 用户说农历6月15对应公历7月28
  { year: 2007, month: 6, day: 15, type: 'lunar' }, // 农历6月15
];

testCases.forEach(tc => {
  if (tc.type === 'solar') {
    const s = Solar.fromYmd(tc.year, tc.month, tc.day);
    const l = s.getLunar();
    console.log(`公历 ${tc.year}-${tc.month}-${tc.day} -> 农历 ${l.getYear()}-${Math.abs(l.getMonth())}-${l.getDay()}`);
  } else {
    const l = Lunar.fromYmd(tc.year, tc.month, tc.day);
    const s = l.getSolar();
    console.log(`农历 ${tc.year}-${tc.month}-${tc.day} -> 公历 ${s.getYear()}-${String(s.getMonth()).padStart(2,'0')}-${String(s.getDay()).padStart(2,'0')}`);
  }
});
