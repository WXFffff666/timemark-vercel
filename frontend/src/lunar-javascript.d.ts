// Local type shim for `lunar-javascript` (^1.7.7). Extend here when new library
// calls are added (todo 77 needs the 宜忌/节气/值星/方位 getters).
declare module 'lunar-javascript' {
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
  }
}
