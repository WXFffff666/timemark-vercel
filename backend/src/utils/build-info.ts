/**
 * Build identity for /deploy-info.
 *
 * The page used to read `process.env.npm_package_version || '2.16.0'`, so it showed
 * 2.16.0 while the README badge and CHANGELOG said 2.22.0 -- npm_package_version only
 * exists when the process was started by an npm/pnpm script, which a Vercel serverless
 * bundle is not. The fallback constant then became the truth nobody updated.
 *
 * Precedence, highest first:
 *   APP_VERSION / COMMIT_SHA / BUILD_TIME  injected at build time by
 *                                          scripts/build-vercel-api.mjs, so the values
 *                                          are frozen into the bundle and cannot drift
 *                                          from the artefact that serves them.
 *   VERCEL_GIT_COMMIT_SHA / npm_package_version  whatever the host happens to provide.
 *   null / 'unknown'                        nothing claimed anything; say so instead of
 *                                          inventing a version.
 */
export interface BuildInfo {
  version: string;
  commitSha: string | null;
  buildTime: string | null;
  platform: 'vercel' | 'local';
  vercelUrl: string | null;
}

const firstNonEmpty = (...values: Array<string | undefined>): string | null => {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
};

export function readBuildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
  return {
    version: firstNonEmpty(env.APP_VERSION, env.npm_package_version) ?? 'unknown',
    commitSha: firstNonEmpty(env.COMMIT_SHA, env.VERCEL_GIT_COMMIT_SHA),
    buildTime: firstNonEmpty(env.BUILD_TIME),
    platform: env.VERCEL ? 'vercel' : 'local',
    vercelUrl: firstNonEmpty(env.VERCEL_URL),
  };
}