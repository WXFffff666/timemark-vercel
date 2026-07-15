import * as esbuild from 'esbuild'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const schedulerStub = join(root, 'backend/src/queue/scheduler.vercel-stub.ts')
const notificationsStub = join(root, 'backend/src/services/notifications.vercel-stub.ts')
const emailStub = join(root, 'backend/src/services/notifications/email.vercel-stub.ts')
const imAuthStub = join(root, 'backend/src/services/notifications/im-auth.vercel-stub.ts')
const pushStub = join(root, 'backend/src/routes/push.vercel-stub.ts')
const testConnectionStub = join(root, 'backend/src/services/notifications/test-connection.vercel-stub.ts')
const networkCheckStub = join(root, 'backend/src/services/notifications/network-check.vercel-stub.ts')
const imServicePattern =
  /[/\\]notifications[/\\](wechaty|whatsapp|qqbot|signal|zalo|bluebubbles|clawbot|wechat-openclaw)\.service\.js$/

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
      name: 'notifications-vercel-stub',
      setup(build) {
        build.onResolve({ filter: /[/\\]notifications[/\\]index\.js$/ }, () => ({
          path: notificationsStub,
        }))
        build.onResolve({ filter: /[/\\]notifications[/\\]email\.service\.js$/ }, () => ({
          path: emailStub,
        }))
        build.onResolve({ filter: imServicePattern }, () => ({
          path: imAuthStub,
        }))
        build.onResolve({ filter: /[/\\]routes[/\\]push\.js$/ }, () => ({
          path: pushStub,
        }))
        build.onResolve({ filter: /[/\\]notifications[/\\]test-connection\.js$/ }, () => ({
          path: testConnectionStub,
        }))
        build.onResolve({ filter: /[/\\]notifications[/\\]network-check\.js$/ }, () => ({
          path: networkCheckStub,
        }))
      },
    },
  ],
  logLevel: 'info',
})

console.log(`[build-vercel-api] Wrote ${outfile}`)
