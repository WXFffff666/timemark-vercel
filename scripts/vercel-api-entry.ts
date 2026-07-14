import { handle } from 'hono/vercel'
import app from '../backend/src/index.js'
import { ensureVercelReady } from '../backend/src/vercel-init.js'

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
}

const initPromise = ensureVercelReady()
const honoHandler = handle(app)

export default async function vercelHandler(req: Request) {
  try {
    await initPromise
    return honoHandler(req)
  } catch (error) {
    console.error('[Vercel API] Initialization or handler error:', error)
    const message = error instanceof Error ? error.message : 'Server error'
    return new Response(
      JSON.stringify({ success: false, error: message }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    )
  }
}
