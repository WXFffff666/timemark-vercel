import { describe, expect, it } from 'vitest';
import { readBuildInfo } from '../utils/build-info.js';

describe('readBuildInfo', () => {
  it('prefers the values frozen into the bundle over anything the host provides', () => {
    const info = readBuildInfo({
      APP_VERSION: '2.22.0',
      COMMIT_SHA: 'abc1234',
      BUILD_TIME: '2026-10-02T08:00:00.000Z',
      VERCEL_GIT_COMMIT_SHA: 'stale9999',
      npm_package_version: '1.0.0',
    } as NodeJS.ProcessEnv);

    expect(info.version).toBe('2.22.0');
    expect(info.commitSha).toBe('abc1234');
    expect(info.buildTime).toBe('2026-10-02T08:00:00.000Z');
  });

  it('falls back to the host environment when nothing was injected', () => {
    const info = readBuildInfo({
      VERCEL: '1',
      VERCEL_URL: 'https://timemark.example.com',
      VERCEL_GIT_COMMIT_SHA: 'def5678',
      npm_package_version: '2.16.0',
    } as NodeJS.ProcessEnv);

    expect(info.version).toBe('2.16.0');
    expect(info.commitSha).toBe('def5678');
    expect(info.buildTime).toBeNull();
    expect(info.platform).toBe('vercel');
    expect(info.vercelUrl).toBe('https://timemark.example.com');
  });

  it('says unknown instead of inventing a version', () => {
    const info = readBuildInfo({} as NodeJS.ProcessEnv);

    expect(info.version).toBe('unknown');
    expect(info.commitSha).toBeNull();
    expect(info.buildTime).toBeNull();
    expect(info.platform).toBe('local');
  });

  it('ignores blank values rather than reporting an empty version', () => {
    const info = readBuildInfo({
      APP_VERSION: '   ',
      COMMIT_SHA: '',
      VERCEL_GIT_COMMIT_SHA: 'aaa1111',
    } as NodeJS.ProcessEnv);

    expect(info.version).toBe('unknown');
    expect(info.commitSha).toBe('aaa1111');
  });
});