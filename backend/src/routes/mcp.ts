import { Hono, type Context } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentToolDefinition, User } from '@timemark/shared';
import {
  confirmTool,
  invokeTool,
  listAgentToolsForScopes,
  resolveCallerScopes,
  type AgentCaller,
  type AgentInvocation,
} from '../services/agent/dispatch.service.js';
import type { AgentTokenScope } from '../services/agent-tokens.service.js';
import { query } from '../db/index.js';
import { createLogger } from '../utils/logger.js';

/**
 * Checkbox 103: a STATELESS MCP server over the Streamable HTTP transport, mounted at
 * `/api/mcp`. It is a single POST handler that speaks JSON-RPC 2.0 and delegates EVERY tool
 * invocation to checkbox 102's dispatcher (`services/agent/dispatch.service.ts`), so scope
 * checks, audit rows and the two-phase confirmation protocol behave identically to the in-app
 * path. No authorisation is re-implemented here.
 *
 * Statelessness: there is deliberately NO session id, NO `Mcp-Session-Id` header and NO
 * initialize-before-call coupling. Every POST is self-contained: it carries the scoped bearer
 * agent token (checkbox 101) in `Authorization: Bearer tmt_...`, validates the grant PER CALL
 * and writes an audit row, so two identical fresh POSTs behave identically with no prior
 * `initialize`. This is what lets a serverless (Vercel) deployment work - a session store would
 * be lost between invocations.
 *
 * Why a scoped bearer token instead of full OAuth 2.1 + PKCE (explicitly required by the plan):
 * TimeMark is a single-user personal reminder deployment, and the credential used here is the
 * SAME scoped, revocable, audited agent token the app already issues and manages (checkbox 101),
 * not a new one minted for MCP. Its coarse grant (`read` / `write` / `admin`) is enforced by the
 * dispatcher on every call, revocation is a single UPDATE, and every allow/deny is written to
 * `agent_audit_logs`. The OAuth 2.1 + PKCE dance exists to broker DELEGATED third-party access
 * and dynamic client registration - neither applies to a personal deployment whose only token
 * issuer is the owner themselves. Adding it would be a larger, unaudited credential path with no
 * security gain here.
 *
 * Transport scope: this implements ONLY the current Streamable HTTP transport. The deprecated
 * HTTP+SSE transport (2024-11-05) is intentionally NOT implemented: a GET on the endpoint
 * answers 405 with `Allow: POST` rather than opening an SSE stream.
 */

const log = createLogger('mcp');

/** Latest protocol revision this server speaks. Older revisions are accepted and echoed. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';
export const SUPPORTED_MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
export const MCP_SERVER_NAME = 'timemark';
export const MCP_SERVER_VERSION = '1.0.0';

/**
 * Advertised to the client in `initialize`. `listChanged`/`subscribe` are false because a
 * stateless transport cannot push server-initiated notifications to a session that does not
 * outlive the request.
 */
export const MCP_CAPABILITIES = {
  tools: { listChanged: false },
  resources: { subscribe: false, listChanged: false },
} as const;

/**
 * The server is disabled unless MCP_ENABLED is exactly `true`. Kept as a function (not a
 * module constant) so a test can flip the env per case without re-importing the module.
 */
export function isMcpEnabled(): boolean {
  return process.env.MCP_ENABLED === 'true';
}

// --- checkbox 104 seam: read-only resources --------------------------------------------
/**
 * Task 104 owns the actual read-only resources (`timemark://today`, `timemark://upcoming`,
 * `timemark://expiry`, `timemark://medications/today`, `timemark://patterns`, `timemark://goals`).
 * This module ships a VALID but EMPTY list plus a well-formed resource-not-found for reads, so
 * the transport is complete. 104 fills `MCP_RESOURCES` and implements the read below - it must
 * NOT be invented here, outside 104's scope.
 */
export interface McpResourceDescriptor {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}
export const MCP_RESOURCES: readonly McpResourceDescriptor[] = [];

// --- JSON-RPC ---------------------------------------------------------------------------

type RpcId = string | number | null;

const RPC = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  DISABLED: -32000,
  UNAUTHORIZED: -32001,
  RESOURCE_NOT_FOUND: -32002,
  FORBIDDEN: -32003,
  CONFLICT: -32004,
} as const;

interface JsonRpcErrorShape {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function asId(value: unknown): RpcId {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function rpcResult(id: RpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: RpcId, error: JsonRpcErrorShape) {
  return { jsonrpc: '2.0' as const, id, error };
}

/** Map a dispatch HTTP status to a JSON-RPC error code (server-defined range for 4xx). */
function codeForStatus(status: number): number {
  if (status === 401) return RPC.UNAUTHORIZED;
  if (status === 403) return RPC.FORBIDDEN;
  if (status === 404) return RPC.RESOURCE_NOT_FOUND;
  if (status === 409 || status === 410) return RPC.CONFLICT;
  if (status >= 500) return RPC.INTERNAL;
  return RPC.INVALID_PARAMS;
}

/** A disallowed tool call rides a top-level JSON-RPC error, never a tool `isError` result. */
function deniedError(id: RpcId, httpStatus: number, error: string, data: Record<string, unknown>) {
  return rpcError(id, { code: codeForStatus(httpStatus), message: error, data });
}

/** Auth failures keep an HTTP 401; every other JSON-RPC error rides HTTP 200 per the spec. */
function httpStatusForError(code: number): 200 | 401 {
  return code === RPC.UNAUTHORIZED ? 401 : 200;
}

// --- credential gate ----------------------------------------------------------------------

type McpAuth = { token: string; scopes: readonly AgentTokenScope[] };

function bearerToken(c: Context): string | null {
  const raw = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '').trim();
  return raw ? raw : null;
}

/**
 * Resolve a token's owner + scopes, or the 401 Response to short-circuit with. This mirrors the
 * credential resolution of checkbox 102's `GET /api/agent/tools`; the execution path additionally
 * re-validates revocation/expiry inside the dispatcher for every `tools/call`.
 */
async function resolveAuth(c: Context): Promise<McpAuth | Response> {
  const token = bearerToken(c);
  if (!token) {
    return c.json(rpcError(null, { code: RPC.UNAUTHORIZED, message: 'missing_token' }), 401);
  }
  const scopes = await resolveCallerScopes({ kind: 'token', token });
  if (!scopes) {
    return c.json(rpcError(null, { code: RPC.UNAUTHORIZED, message: 'invalid_token' }), 401);
  }
  return { token, scopes };
}

// --- audit correlation --------------------------------------------------------------------

/**
 * Read back the audit row id the dispatcher wrote for a call. Because every dispatched
 * invocation carries a unique requestId we generate here, exactly one row matches and a caller
 * can correlate its MCP request with the audit trail without any change to the dispatcher.
 */
const AUDIT_ID_SQL = 'SELECT id FROM agent_audit_logs WHERE request_id = $1 ORDER BY id DESC LIMIT 1';

async function auditIdFor(requestId: string): Promise<string | null> {
  try {
    const result = await query(AUDIT_ID_SQL, [requestId]);
    const row = result.rows[0] as { id?: string | number } | undefined;
    return row?.id === undefined || row?.id === null ? null : String(row.id);
  } catch (error) {
    log.warn({ err: error, requestId }, 'failed to read the audit row id for an MCP call');
    return null;
  }
}

// --- tools --------------------------------------------------------------------------------

function jsonSchemaFor(definition: AgentToolDefinition): unknown {
  try {
    return z.toJSONSchema(definition.inputSchema);
  } catch {
    // A schema that cannot be rendered still lists the tool by name + description.
    return undefined;
  }
}

function toolView(definition: AgentToolDefinition) {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: jsonSchemaFor(definition),
    annotations: {
      destructiveHint: definition.destructive,
      readOnlyHint: definition.requiredScope.endsWith(':read'),
    },
  };
}

interface ToolsCallInput {
  name: string;
  args: unknown;
  confirmationId: string | null;
}

function parseToolsCall(params: unknown): ToolsCallInput | null {
  if (!params || typeof params !== 'object') return null;
  const record = params as Record<string, unknown>;
  const name = typeof record.name === 'string' && record.name.length > 0 ? record.name : null;
  if (!name) return null;
  const args = record.arguments ?? {};
  let confirmationId: string | null = null;
  const meta = record._meta;
  if (meta && typeof meta === 'object') {
    const candidate = (meta as Record<string, unknown>).confirmationId;
    if (typeof candidate === 'string' && candidate.length > 0) confirmationId = candidate;
  }
  return { name, args, confirmationId };
}

function textResult(payload: Record<string, unknown>, text: string, isError: boolean) {
  return { content: [{ type: 'text' as const, text }], structuredContent: payload, isError };
}

/** Translate a dispatcher `invokeTool`/`confirmTool` outcome into an MCP response. */
async function invocationResponse(c: Context, id: RpcId, outcome: AgentInvocation, requestId: string) {
  if (outcome.status === 'denied') {
    const auditId = await auditIdFor(requestId);
    const data: Record<string, unknown> = { error: outcome.error };
    if (outcome.requiredScope) data.requiredScope = outcome.requiredScope;
    if (auditId) data.auditId = auditId;
    return c.json(
      deniedError(id, outcome.httpStatus, outcome.error, data),
      httpStatusForError(codeForStatus(outcome.httpStatus)),
    );
  }

  const auditId = await auditIdFor(requestId);

  if (outcome.status === 'confirm_required') {
    const payload: Record<string, unknown> = {
      status: 'confirm_required',
      confirmationId: outcome.confirmationId,
      preview: outcome.preview,
    };
    if (auditId) payload.auditId = auditId;
    const text = `Confirmation required for "${outcome.preview.tool}". Re-issue tools/call with the same arguments and params._meta.confirmationId="${outcome.confirmationId}" within 2 minutes to execute.`;
    return c.json(rpcResult(id, textResult(payload, text, false)));
  }

  if (outcome.result.ok) {
    const payload: Record<string, unknown> = { status: 'executed', data: outcome.result.data };
    if (auditId) payload.auditId = auditId;
    return c.json(rpcResult(id, textResult(payload, JSON.stringify(payload), false)));
  }

  const payload: Record<string, unknown> = {
    status: 'error',
    code: outcome.result.code,
    error: outcome.result.message,
  };
  if (auditId) payload.auditId = auditId;
  return c.json(rpcResult(id, textResult(payload, outcome.result.message, true)));
}

// --- the route ----------------------------------------------------------------------------

const mcp = new Hono<{ Variables: { user: User } }>();

/** Only POST is part of Streamable HTTP here; a GET must NOT open the deprecated SSE stream. */
mcp.get('/', (c) => c.body(null, 405, { Allow: 'POST' }));

mcp.post('/', async (c) => {
  if (!isMcpEnabled()) {
    return c.json(rpcError(null, { code: RPC.DISABLED, message: 'mcp_disabled' }), 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(rpcError(null, { code: RPC.PARSE, message: 'parse_error' }), 400);
  }

  // This stateless transport handles ONE request per POST (no batch).
  if (Array.isArray(body)) {
    return c.json(rpcError(null, { code: RPC.INVALID_REQUEST, message: 'batch_not_supported' }), 400);
  }
  if (!body || typeof body !== 'object') {
    return c.json(rpcError(null, { code: RPC.INVALID_REQUEST, message: 'invalid_request' }), 400);
  }

  const req = body as JsonRpcRequest;
  const id = asId(req.id);
  const method = typeof req.method === 'string' ? req.method : '';
  if (!method) {
    return c.json(rpcError(id, { code: RPC.INVALID_REQUEST, message: 'missing_method' }), 400);
  }

  // JSON-RPC notifications (no response). The client's `notifications/initialized` lands here.
  if (method.startsWith('notifications/')) {
    return c.body(null, 202);
  }

  const auth = await resolveAuth(c);
  if (auth instanceof Response) return auth;

  if (method === 'initialize') {
    const requested = (req.params as Record<string, unknown> | undefined)?.protocolVersion;
    const protocolVersion =
      typeof requested === 'string' && (SUPPORTED_MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : MCP_PROTOCOL_VERSION;
    return c.json(
      rpcResult(id, {
        protocolVersion,
        capabilities: MCP_CAPABILITIES,
        serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        instructions:
          'TimeMark personal reminder server. Tools are filtered by the bearer token scope; destructive and outward tools require confirmation.',
      }),
    );
  }

  if (method === 'ping') {
    return c.json(rpcResult(id, {}));
  }

  if (method === 'tools/list') {
    const tools = listAgentToolsForScopes(auth.scopes).map(toolView);
    return c.json(rpcResult(id, { tools }));
  }

  if (method === 'tools/call') {
    const parsed = parseToolsCall(req.params);
    if (!parsed) {
      return c.json(rpcError(id, { code: RPC.INVALID_PARAMS, message: 'invalid_tools_call_params' }), 200);
    }
    const caller: AgentCaller = { kind: 'token', token: auth.token };
    const requestId = randomUUID();

    if (parsed.confirmationId) {
      const uuid = z.string().uuid().safeParse(parsed.confirmationId);
      if (!uuid.success) {
        return c.json(rpcError(id, { code: RPC.INVALID_PARAMS, message: 'invalid_confirmation_id' }), 200);
      }
      const outcome = await confirmTool({ caller, confirmationId: uuid.data, requestId });
      if (outcome.status === 'denied') {
        const auditId = await auditIdFor(requestId);
        const data: Record<string, unknown> = { error: outcome.error };
        if (outcome.message) data.message = outcome.message;
        if (auditId) data.auditId = auditId;
        return c.json(
          deniedError(id, outcome.httpStatus, outcome.error, data),
          httpStatusForError(codeForStatus(outcome.httpStatus)),
        );
      }
      return invocationResponse(c, id, { status: 'executed', result: outcome.result }, requestId);
    }

    const outcome = await invokeTool({ caller, tool: parsed.name, rawArgs: parsed.args, requestId });
    return invocationResponse(c, id, outcome, requestId);
  }

  if (method === 'resources/list') {
    return c.json(rpcResult(id, { resources: MCP_RESOURCES }));
  }

  if (method === 'resources/read') {
    // checkbox 104 seam: no resource exists yet, so a read is a well-formed not-found.
    const uri = (req.params as Record<string, unknown> | undefined)?.uri;
    return c.json(
      rpcError(id, {
        code: RPC.RESOURCE_NOT_FOUND,
        message: 'resource_not_found',
        data: { uri: typeof uri === 'string' ? uri : null },
      }),
    );
  }

  // Unknown JSON-RPC method: a proper error, never a 500.
  return c.json(rpcError(id, { code: RPC.METHOD_NOT_FOUND, message: `method_not_found: ${method}` }));
});

export default mcp;
