import * as esbuild from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const schedulerStub = join(root, 'backend/src/queue/scheduler.vercel-stub.ts')
const imServicePattern =
  /[/\\]notifications[/\\](wechaty|whatsapp|qqbot|signal|zalo|bluebubbles|clawbot|wechat-openclaw|nostr)\.service\.js$/
const imAuthStub = join(root, 'backend/src/services/notifications/im-auth.vercel-stub.ts')

const outfile = 'api/handler.cjs'

mkdirSync(dirname(outfile), { recursive: true })

await esbuild.build({
  entryPoints: ['scripts/vercel-api-entry.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile,
  mainFields: ['module', 'main'],
  packages: 'bundle',
  external: [
    'baileys',
    'wechaty',
    'oicq',
    '@tencent-weixin/openclaw-weixin',
  ],
  plugins: [
    {
      name: 'scheduler-vercel-stub',
      setup(build) {
        build.onResolve({ filter: /[/\\]queue[/\\]scheduler\.js$/ }, () => ({
          path: schedulerStub,
        }))
      },
    },
    {
      name: 'drop-removed-channel-services',
      setup(build) {
        build.onResolve({ filter: imServicePattern }, () => ({
          path: imAuthStub,
        }))
      },
    },
  ],
  logLevel: 'info',
})

console.log(`[build-vercel-api] Wrote ${outfile}`)
