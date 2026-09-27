declare module 'lunar-javascript' {
  export class Lunar {
    static fromDate(date: Date): Lunar;
    static fromYmd(year: number, month: number, day: number): Lunar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    getSolar(): Solar;
    toString(): string;
    /** 当日节气名（无则为空串）；需由 `Solar.fromYmd().getLunar()` 路径获取（checkbox 78）。 */
    getJieQi(): string;
  }
  export class Solar {
    static fromDate(date: Date): Solar;
    static fromYmd(year: number, month: number, day: number): Solar;
    getLunar(): Lunar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
  }
}
