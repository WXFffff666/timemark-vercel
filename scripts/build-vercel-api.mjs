import * as esbuild from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const schedulerStub = join(root, 'backend/src/queue/scheduler.vercel-stub.ts')

const outfile = 'api/handler.cjs'

mkdirSync(dirname(outfile), { recursive: true })

// Build identity, frozen into the bundle instead of read at runtime. /deploy-info used to
// report `process.env.npm_package_version || '2.16.0'`, and neither exists in a serverless
// function started by Vercel, so the page showed 2.16.0 forever while the README said 2.22.0.
// Each value can be pinned through the environment to keep a build reproducible.
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const gitSha = () => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Banner, not `define`: the backend passes `process.env` around as an object
// (`readBuildInfo(env = process.env)`), and esbuild's define only rewrites the literal text
// `process.env.APP_VERSION`, so it silently did nothing here. Assigning the values in a
// banner is the one injection point that covers property access on the env object.
const version = process.env.APP_VERSION || pkg.version
const commitSha = process.env.COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA || gitSha()
const buildTime = process.env.BUILD_TIME || new Date().toISOString()

const banner = [
  `process.env.APP_VERSION=${JSON.stringify(version)};`,
  `process.env.COMMIT_SHA=${JSON.stringify(commitSha)};`,
  `process.env.BUILD_TIME=${JSON.stringify(buildTime)};`,
].join('')

await esbuild.build({
  entryPoints: ['scripts/vercel-api-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  mainFields: ['module', 'main'],
  packages: 'bundle',
  banner: { js: banner },
  plugins: [
    {
      name: 'scheduler-vercel-stub',
      setup(build) {
        build.onResolve({ filter: /[/\\]queue[/\\]scheduler\.js$/ }, () => ({
          path: schedulerStub,
        }))
      },
    },
  ],
  logLevel: 'info',
})

console.log(`[build-vercel-api] Wrote ${outfile}`)
console.log(`[build-vercel-api] ${version} @ ${commitSha || 'unknown sha'}`)
