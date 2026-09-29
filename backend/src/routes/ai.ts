import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.middleware.js';
import {
  getAiStatusWithProbe,
  testAiConnection,
  type AiProviderName,
} from '../services/ai/gateway.js';
import type { User } from '@timemark/shared';

const aiRoutes = new Hono<{ Variables: { user: User } }>();

aiRoutes.use('*', authMiddleware);

const PROVIDER_NAMES: readonly AiProviderName[] = ['primary', 'fallback', 'local'];

function asProviderName(value: unknown): AiProviderName | undefined {
  return typeof value === 'string' && (PROVIDER_NAMES as readonly string[]).includes(value)
    ? (value as AiProviderName)
    : undefined;
}

/**
 * checkbox 98 + 107: which AI provider resolves right now (`enabled:false` when
 * no `AI_*` / `OLLAMA_MODEL` env is set). The active provider is probed with a
 * SHORT timeout so the route never stalls, and the payload contains hostnames
 * and model names only - never an API key and never a full base URL.
 */
aiRoutes.get('/status', async (c) => c.json({ success: true, data: await getAiStatusWithProbe() }));

/**
 * checkbox 107: "测试连接" - send ONE tiny prompt to a named provider (default:
 * the active one) and report success + latency, or the typed error. The body
 * accepts ONLY a provider NAME from a fixed allow-list; no request-supplied
 * base URL ever reaches provider resolution (SSRF guard).
 */
aiRoutes.post('/test', async (c) => {
  let provider: AiProviderName | undefined;
  try {
    const body = (await c.req.json()) as unknown;
    if (body && typeof body === 'object') {
      provider = asProviderName((body as { provider?: unknown }).provider);
    }
  } catch {
    // No or invalid JSON body -> test the active provider.
  }
  return c.json({ success: true, data: await testAiConnection(provider) });
});

export default aiRoutes;
