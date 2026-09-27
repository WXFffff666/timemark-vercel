import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checkbox 70: the profile switcher selection is persisted per device
 * (localStorage `timemark.profileId`) and self-heals when the selected profile
 * disappears (deleted / archived -> fall back to "all profiles").
 */

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }));
vi.mock('@/lib/api', () => ({ api: { get: getMock } }));

async function freshStore() {
  vi.resetModules();
  const mod = await import('./profile.store');
  return mod.useProfileStore;
}

function profile(id: number, name: string) {
  return {
    id,
    user_id: 1,
    name,
    relation: null,
    kind: 'family',
    birth_date: null,
    lunar_birthday: null,
    avatar_emoji: null,
    timezone: null,
    sort_order: 0,
    is_active: true,
    created_at: null,
    updated_at: null,
  };
}

beforeEach(() => {
  localStorage.clear();
  getMock.mockReset();
});

describe('profile.store (checkbox 70)', () => {
  it('restores the per-device selection from localStorage on init', async () => {
    localStorage.setItem('timemark.profileId', '7');
    const store = await freshStore();
    expect(store.getState().profileId).toBe(7);
  });

  it('ignores a malformed persisted value', async () => {
    localStorage.setItem('timemark.profileId', 'not-a-number');
    const store = await freshStore();
    expect(store.getState().profileId).toBeNull();
  });

  it('setProfileId persists the id and null clears it', async () => {
    const store = await freshStore();

    store.getState().setProfileId(5);
    expect(localStorage.getItem('timemark.profileId')).toBe('5');
    expect(store.getState().profileId).toBe(5);

    store.getState().setProfileId(null);
    expect(localStorage.getItem('timemark.profileId')).toBeNull();
    expect(store.getState().profileId).toBeNull();

    // invalid ids degrade to "all profiles" and never write a bogus value.
    store.getState().setProfileId(0);
    expect(store.getState().profileId).toBeNull();
    store.getState().setProfileId(-3);
    expect(localStorage.getItem('timemark.profileId')).toBeNull();
  });

  it('load() keeps a valid selection and clears a stale one', async () => {
    localStorage.setItem('timemark.profileId', '99');
    getMock.mockResolvedValue([profile(11, '我'), profile(12, '小明')]);
    const store = await freshStore();

    await store.getState().load();

    expect(getMock).toHaveBeenCalledWith('/profiles?active=true');
    expect(store.getState().profiles.map((p) => p.id)).toEqual([11, 12]);
    expect(store.getState().profileId).toBeNull();
    expect(localStorage.getItem('timemark.profileId')).toBeNull();
  });

  it('load() keeps the selection when the profile still exists', async () => {
    localStorage.setItem('timemark.profileId', '12');
    getMock.mockResolvedValue([profile(11, '我'), profile(12, '小明')]);
    const store = await freshStore();

    await store.getState().load();

    expect(store.getState().profileId).toBe(12);
    expect(localStorage.getItem('timemark.profileId')).toBe('12');
  });

  it('load() never throws when the API fails', async () => {
    getMock.mockRejectedValue(new Error('offline'));
    const store = await freshStore();

    await expect(store.getState().load()).resolves.toBeUndefined();
    expect(store.getState().loaded).toBe(true);
    expect(store.getState().profiles).toEqual([]);
  });
});
