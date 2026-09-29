import { Hono } from 'hono';
import { z } from 'zod';
import { AGENT_TOOLS, type AgentToolDefinition, type User } from '@timemark/shared';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { agentRateLimit } from '../services/agent/rate-limit.service.js';
import { resolveAgentTokenCredential, type AgentTokenScope } from '../services/agent-tokens.service.js';
import {
  AGENT_TOOLS_DISABLED_ERROR,
  agentToolsEnabled,
  confirmTool,
  invokeTool,
  listAgentToolsForScopes,
  type AgentCaller,
  type AgentInvocation,
} from '../services/agent/dispatch.service.js';

/**
 * Checkbox 102: the agent action API, mounted at `/api/agent`.
 *
 *   GET  /api/agent/tools              -> the registry, filtered by the calling token's scope
 *   POST /api/agent/actions/:tool      -> validate -> authorise -> (confirm | execute) -> audit
 *   POST /api/agent/confirm/:id        -> consume a pending confirmation (single-use, 2-min TTL)
 *
 * Auth accepts EITHER a Bearer agent token (`tmt_...`) OR the normal session cookie/Bearer JWT,
 * so the in-app assistant shares this exact path. There is deliberately NO endpoint that runs a
 * handler supplied in the request - the only accepted input is a registry tool NAME plus its
 * typed arguments; an unknown name is a 404 and never reaches a handler.
 */
const agent = new Hono<{ Variables: { user: User } }>();

/**
 * Task 110 (b): the global kill switch runs before the rate limiter and EVERY route, so
 * `AGENT_TOOLS_ENABLED=false` disables the whole action API (tools/actions/confirm) with one
 * documented 503. MCP reads the same `agentToolsEnabled()` flag, so the two surfaces cannot
 * disagree.
 */
agent.use('*', async (c, next) => {
  if (!agentToolsEnabled()) {
    return c.json({ success: false, error: AGENT_TOOLS_DISABLED_ERROR }, 503);
  }
  await next();
});

agent.use('*', agentRateLimit());

/** Resolve the credential shape, or return the 401 Response to short-circuit with. */
async function resolveCaller(c: Parameters<typeof authMiddleware>[0]): Promise<AgentCaller | Response> {
  const bearer = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  if (bearer && bearer.startsWith('tmt_')) {
    return { kind: 'token', token: bearer };
  }
  const fromSession = await authMiddleware(c, async () => {});
  if (fromSession instanceof Response) return fromSession;
  const user = c.get('user');
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);
  return { kind: 'session', userId: Number(user.id) };
}

function jsonSchemaFor(definition: AgentToolDefinition): unknown {
  try {
    return z.toJSONSchema(definition.inputSchema);
  } catch {
    return undefined;
  }
}

function toolView(definition: AgentToolDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    requiredScope: definition.requiredScope,
    destructive: definition.destructive,
    requiresConfirmation: definition.requiresConfirmation,
    inputSchema: jsonSchemaFor(definition),
  };
}

agent.get('/tools', async (c) => {
  const caller = await resolveCaller(c);
  if (caller instanceof Response) return caller;

  // Task 110: a read-only gate re-validates the credential itself (revoked / expired), not
  // just the scope grant. A session is the authenticated owner; a token goes through the
  // shared credential resolver, so a revoked token can no longer enumerate the registry.
  let scopes: readonly AgentTokenScope[];
  if (caller.kind === 'session') {
    scopes = ['admin'];
  } else {
    const credential = await resolveAgentTokenCredential(caller.token);
    if (credential.status !== 'ok') {
      const error = credential.status === 'unknown' ? 'invalid_token' : `token_${credential.status}`;
      return c.json({ success: false, error }, 401);
    }
    scopes = credential.scopes;
  }

  // A session is the owner: full registry. A token only sees tools its grant permits.
  const tools = caller.kind === 'session' ? AGENT_TOOLS : listAgentToolsForScopes(scopes);
  return c.json({ success: true, data: { tools: tools.map(toolView) } });
});

agent.post('/actions/:tool', async (c) => {
  const caller = await resolveCaller(c);
  if (caller instanceof Response) return caller;

  const tool = c.req.param('tool');
  const body = (await c.req.json().catch(() => ({}))) as unknown;
  const rawArgs =
    body && typeof body === 'object' && 'args' in (body as Record<string, unknown>)
      ? (body as Record<string, unknown>).args
      : body;
  const requestId = c.req.header('X-Request-ID') ?? null;

  const outcome: AgentInvocation = await invokeTool({ caller, tool, rawArgs, requestId });

  if (outcome.status === 'denied') {
    return c.json(
      {
        success: false,
        error: outcome.error,
        ...(outcome.requiredScope ? { requiredScope: outcome.requiredScope } : {}),
      },
      outcome.httpStatus as 400 | 401 | 403 | 404,
    );
  }
  if (outcome.status === 'confirm_required') {
    return c.json(
      {
        success: true,
        data: {
          status: 'confirm_required',
          confirmationId: outcome.confirmationId,
          preview: outcome.preview,
        },
      },
      202,
    );
  }
  if (outcome.result.ok) {
    return c.json({ success: true, data: outcome.result.data });
  }
  return c.json(
    { success: false, error: outcome.result.message, code: outcome.result.code },
    outcome.result.status as 400 | 401 | 403 | 404 | 409 | 500,
  );
});

agent.post('/confirm/:id', async (c) => {
  const caller = await resolveCaller(c);
  if (caller instanceof Response) return caller;

  const confirmationId = c.req.param('id');
  const parsedId = z.string().uuid().safeParse(confirmationId);
  if (!parsedId.success) return c.json({ success: false, error: 'invalid_confirmation_id' }, 400);

  const requestId = c.req.header('X-Request-ID') ?? null;
  const outcome = await confirmTool({ caller, confirmationId: parsedId.data, requestId });

  if (outcome.status === 'denied') {
    return c.json(
      { success: false, error: outcome.error, ...(outcome.message ? { message: outcome.message } : {}) },
      outcome.httpStatus as 400 | 401 | 403 | 404 | 409 | 410,
    );
  }
  if (outcome.result.ok) {
    return c.json({ success: true, data: outcome.result.data });
  }
  return c.json(
    { success: false, error: outcome.result.message, code: outcome.result.code },
    outcome.result.status as 400 | 401 | 403 | 404 | 409 | 500,
  );
});

export default agent;
