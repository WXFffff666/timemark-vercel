import { handle } from 'hono/vercel'
import app from '../backend/src/index'
import { ensureVercelReady } from '../backend/src/vercel-init'

export const config = {
  runtime: 'nodejs',
  maxDuration: 30,
}

const handler = handle(app)

export default async function vercelHandler(req: Request, context: unknown) {
  await ensureVercelReady()
  return handler(req, context)
}
