import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdherenceReport } from '@timemark/shared';

/**
 * Checkbox 74 - the report builder must reuse the checkbox 72 maths and keep
 * every read user/profile-scoped. These tests assert composition: each source
 * service is called with the authenticated user id and the same profile filter,
 * and the profile name is resolved from the owned profile (never from input).
 */

const med = vi.hoisted(() => ({
  getAdherence: vi.fn(),
  getAdherenceDaily: vi.fn(),
  getRefills: vi.fn(),
  listMedications: vi.fn(),
}));
vi.mock('../services/medication.service.js', () => med);

const profiles = vi.hoisted(() => ({ getProfile: vi.fn() }));
vi.mock('../services/profile.service.js', () => profiles);

import { ALL_PROFILES_LABEL, buildMedicationReport } from '../services/medication-report.service.js';

const ADHERENCE: AdherenceReport = {
  from: '2026-09-01',
  to: '2026-09-03',
  overall: { taken: 2, skipped: 1, missed: 1, total: 4, percentage: 50, currentStreak: 1 },
  medications: [
    { medicationId: 5, name: '二甲双胍', taken: 2, skipped: 1, missed: 1, total: 4, percentage: 50, currentStreak: 1 },
  ],
};

beforeEach(() => {
  for (const fn of Object.values(med)) fn.mockReset();
  profiles.getProfile.mockReset();
  med.getAdherence.mockResolvedValue(ADHERENCE);
  med.getAdherenceDaily.mockResolvedValue([{ date: '2026-09-01', taken: 2, skipped: 0, missed: 1 }]);
  med.listMedications.mockResolvedValue([]);
  med.getRefills.mockResolvedValue([]);
});

describe('buildMedicationReport (checkbox 74)', () => {
  it('reads every source scoped to the user and the requested profile', async () => {
    profiles.getProfile.mockResolvedValue({ id: 11, name: '小明' });
    const view = await buildMedicationReport(7, '2026-09-01', '2026-09-03', { profileId: 11 });

    expect(med.getAdherence).toHaveBeenCalledWith(7, '2026-09-01', '2026-09-03', { profileId: 11 });
    expect(med.getAdherenceDaily).toHaveBeenCalledWith(7, '2026-09-01', '2026-09-03', { profileId: 11 });
    expect(med.listMedications).toHaveBeenCalledWith(7, { profileId: 11 });
    expect(med.getRefills).toHaveBeenCalledWith(7, { profileId: 11 });
    expect(profiles.getProfile).toHaveBeenCalledWith(7, 11);
    expect(view.profileName).toBe('小明');
    expect(view.adherence).toBe(ADHERENCE);
    expect(view.daily).toHaveLength(1);
    expect(view.from).toBe('2026-09-01');
  });

  it('labels an omitted profileId as 全部档案 and never looks up a profile', async () => {
    const view = await buildMedicationReport(7, '2026-09-01', '2026-09-03', { profileId: null });
    expect(view.profileName).toBe(ALL_PROFILES_LABEL);
    expect(profiles.getProfile).not.toHaveBeenCalled();
    expect(med.getAdherence).toHaveBeenCalledWith(7, '2026-09-01', '2026-09-03', { profileId: null });
  });

  it('falls back to a neutral label when the profile row is gone (no crash, no leak)', async () => {
    profiles.getProfile.mockResolvedValue(null);
    const view = await buildMedicationReport(7, '2026-09-01', '2026-09-03', { profileId: 99 });
    expect(view.profileName).toBe('档案 #99');
  });

  it('passes an empty period through as a valid empty view', async () => {
    med.getAdherence.mockResolvedValue({
      from: '2026-09-01',
      to: '2026-09-03',
      overall: { taken: 0, skipped: 0, missed: 0, total: 0, percentage: 0, currentStreak: 0 },
      medications: [],
    });
    med.getAdherenceDaily.mockResolvedValue([]);
    profiles.getProfile.mockResolvedValue({ id: 11, name: '我' });

    const view = await buildMedicationReport(7, '2026-09-01', '2026-09-03', { profileId: 11 });
    expect(view.adherence.overall.percentage).toBe(0);
    expect(view.adherence.medications).toEqual([]);
    expect(view.daily).toEqual([]);
    expect(view.medications).toEqual([]);
    expect(view.refills).toEqual([]);
  });
});
