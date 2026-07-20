import { describe, it, expect } from 'vitest';
import { inferDatabaseRegionHint, isPreferredCnVercelRegion } from '../utils/infra-region.js';

describe('infra-region', () => {
  it('infers Hong Kong Neon host', () => {
    expect(
      inferDatabaseRegionHint('postgresql://u:p@ep-foo.ap-east-1.aws.neon.tech/neondb'),
    ).toBe('ap-east-1 (香港)');
  });

  it('infers Singapore Neon host', () => {
    expect(
      inferDatabaseRegionHint('postgresql://u:p@ep-bar.ap-southeast-1.aws.neon.tech/neondb'),
    ).toBe('ap-southeast-1 (新加坡)');
  });

  it('infers US East host', () => {
    expect(
      inferDatabaseRegionHint('postgresql://u:p@ep-baz.us-east-1.aws.neon.tech/neondb'),
    ).toBe('us-east (美国东岸)');
  });

  it('recognizes preferred APAC vercel regions', () => {
    expect(isPreferredCnVercelRegion('hkg1')).toBe(true);
    expect(isPreferredCnVercelRegion('sin1')).toBe(true);
    expect(isPreferredCnVercelRegion('iad1')).toBe(false);
  });
});
