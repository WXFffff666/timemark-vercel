import { differenceInDays, differenceInHours, differenceInMinutes } from 'date-fns';

export interface CountdownResult {
  days: number;
  hours: number;
  minutes: number;
  isPast: boolean;
}

export function calculateCountdown(targetDate: Date): CountdownResult {
  // Use UTC time for consistent calculation
  const now = new Date();
  const nowUTC = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const targetUTC = Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate());
  
  const isPast = targetUTC < nowUTC;
  const diff = Math.abs(targetUTC - nowUTC);
  
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  return { days, hours, minutes, isPast };
}
