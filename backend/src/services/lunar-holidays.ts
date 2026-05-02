import { Lunar } from 'lunar-javascript';
import { query } from '../db/index.js';

// Major Chinese lunar holidays that should have auto-reminders
const LUNAR_HOLIDAYS = [
  { name: '春节', month: 1, day: 1, type: 'holiday' },
  { name: '元宵节', month: 1, day: 15, type: 'holiday' },
  { name: '端午节', month: 5, day: 5, type: 'holiday' },
  { name: '七夕节', month: 7, day: 7, type: 'holiday' },
  { name: '中秋节', month: 8, day: 15, type: 'holiday' },
  { name: '重阳节', month: 9, day: 9, type: 'holiday' },
  { name: '除夕', month: 12, day: 30, type: 'holiday' },
];

/**
 * Check if lunar holiday events exist for the current user, create if missing.
 * Called during bootstrap for each user.
 */
export async function ensureLunarHolidayEvents(userId: number): Promise<void> {
  const currentYear = new Date().getFullYear();

  for (const holiday of LUNAR_HOLIDAYS) {
    try {
      // Convert lunar to solar for this year
      const lunar = Lunar.fromYmd(currentYear, holiday.month, holiday.day);
      const solar = lunar.getSolar();
      const solarDate = `${solar.getYear()}-${String(solar.getMonth()).padStart(2, '0')}-${String(solar.getDay()).padStart(2, '0')}`;

      // Check if event already exists
      const existing = await query(
        `SELECT id FROM events WHERE user_id = $1 AND name = $2 AND date = $3`,
        [userId, holiday.name, solarDate]
      );

      if (existing.rows.length === 0) {
        // Create the holiday event
        await query(
          `INSERT INTO events (user_id, name, type, date, calendar_type, lunar_date, reminder_config, notification_channels)
           VALUES ($1, $2, $3, $4, 'lunar', $5, $6, $7)`,
          [
            userId,
            holiday.name,
            holiday.type,
            solarDate,
            JSON.stringify({ year: currentYear, month: holiday.month, day: holiday.day, isLeap: false }),
            JSON.stringify({ enabled: true, daysBeforeList: [1, 3] }),
            JSON.stringify([]),
          ]
        );
        console.log(`[LunarHolidays] Created ${holiday.name} event for user ${userId}`);
      }
    } catch (error) {
      console.error(`[LunarHolidays] Failed to process ${holiday.name}:`, error);
    }
  }
}
