declare module 'lunar-javascript' {
  export class Lunar {
    static fromDate(date: Date): Lunar;
    getYear(): number;
    getMonth(): number;
    getDay(): number;
    toString(): string;
  }
  export class Solar {
    static fromDate(date: Date): Solar;
    getLunar(): Lunar;
  }
}
