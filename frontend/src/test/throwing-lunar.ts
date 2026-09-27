import { vi } from 'vitest';
import { Solar } from 'lunar-javascript';

/**
 * Failure-scenario helper for todo 77: make every `Lunar.getDayYi()` throw.
 *
 * The library internally calls the public `Solar.fromYmdHms` while computing
 * lunar data, so the stub must NOT compute `getLunar()` inside the mock
 * (that recurses). Instead each returned Solar gets a lazily-wrapped
 * `getLunar()`; only when the app asks for the lunar object do we swap in the
 * throwing field.
 *
 * Call `vi.restoreAllMocks()` in afterEach.
 */
export function stubThrowingGetDayYi(): void {
  const original = Solar.fromYmdHms.bind(Solar);
  vi.spyOn(Solar, 'fromYmdHms').mockImplementation((...args: Parameters<typeof Solar.fromYmdHms>) => {
    const solar = original(...args);
    const realGetLunar = solar.getLunar.bind(solar);
    let cached: ReturnType<typeof realGetLunar> | null = null;
    solar.getLunar = () => {
      if (!cached) {
        cached = realGetLunar();
        cached.getDayYi = () => {
          throw new Error('stubbed getDayYi failure');
        };
      }
      return cached;
    };
    return solar;
  });
}
