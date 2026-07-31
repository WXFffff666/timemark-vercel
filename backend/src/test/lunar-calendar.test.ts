import { describe, it, expect } from 'vitest';
import { runLunarCalendarSelfTest } from '@timemark/shared/lunar-calendar';
import { lunarConverter } from '../utils/lunar-converter.js';

describe('lunar converter integration', () => {
  it('passes reference samples with lunar-javascript', () => {
    const result = runLunarCalendarSelfTest(lunarConverter);
    expect(result.ok).toBe(true);
  });
});
