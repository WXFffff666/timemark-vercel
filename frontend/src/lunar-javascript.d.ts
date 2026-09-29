// Local type shim for `lunar-javascript` (^1.7.7). Extend here when new library
// calls are added (todo 77 needs the 宜忌/节气/值星/方位 getters; todo 150 adds
// the 八字/彭祖百忌/吉神宜趋 surface). Only the members actually called are typed
// — no `any` escapes.
declare module 'lunar-javascript' {
  export class EightChar {
    getYear(): string;
    getMonth(): string;
    getDay(): string;
    getTime(): string;
    getYearGan(): string;
    getMonthGan(): string;
    getDayGan(): string;
    getTimeGan(): string;
    getYearZhi(): string;
    getMonthZhi(): string;
    getDayZhi(): string;
    getTimeZhi(): string;
    getYearWuXing(): string;
    getMonthWuXing(): string;
    getDayWuXing(): string;
    getTimeWuXing(): string;
  }

  export class Solar {
    static fromDate(date: Date): Solar;
    static fromYmd(year: number, month: number, day: number): Solar;
    static fromYmdHms(year: number, month: number, day: number, hour: number, minute: number, second: number): Solar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    getXingZuo(): string;
    toYmd(): string;
    getLunar(): Lunar;
  }

  export class JieQi {
    getName(): string;
    getSolar(): Solar;
    toString(): string;
  }

  export class Lunar {
    static fromYmd(year: number, month: number, day: number): Lunar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    isLeap(): boolean;
    getSolar(): Solar;
    toString(): string;
    getJieQi(): string;
    getPrevJieQi(): JieQi;
    getNextJieQi(): JieQi;
    getYearInGanZhi(): string;
    getMonthInGanZhi(): string;
    getDayInGanZhi(): string;
    getYearShengXiao(): string;
    getDayYi(): string[];
    getDayJi(): string[];
    getZhiXing(): string;
    getDayPositionXi(): string;
    getDayPositionCai(): string;
    getDayPositionFu(): string;
    getDayPositionXiDesc(): string;
    getDayPositionCaiDesc(): string;
    getDayPositionFuDesc(): string;
    getDayChongDesc(): string;
    getDaySha(): string;
    getEightChar(): EightChar;
    getPengZuGan(): string;
    getPengZuZhi(): string;
    getDayJiShen(): string[];
    getDayXiongSha(): string[];
  }
}
