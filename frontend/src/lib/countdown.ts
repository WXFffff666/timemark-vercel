import { differenceInMilliseconds } from 'date-fns';

export interface CountdownResult {
  days: number;
  hours: number;
  minutes: number;
  isPast: boolean;
}

/** @deprecated 请使用 calendar-utils 的 getEventCountdownTarget + diffToCountdownParts */
export function calculateCountdown(targetDate: Date, ref = new Date()): CountdownResult {
  const diff = differenceInMilliseconds(targetDate, ref);
  const isPast = diff <= 0;
  const abs = Math.abs(diff);

  return {
    days: Math.floor(abs / 86400000),
    hours: Math.floor((abs % 86400000) / 3600000),
    minutes: Math.floor((abs % 3600000) / 60000),
    isPast,
  };
}
