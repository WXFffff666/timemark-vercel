import { createLogger } from '../../utils/logger.js';

/**
 * Checkbox 121(h): central egress guard - the ONE outbound HTTP client agent/job code
 * should use.
 *
 *  - ALLOWLIST: an explicit host list = the configured notification provider hosts
 *    (NOTIFICATION_PROVIDER_HOSTS + EGRESS_ALLOWED_HOSTS additions), the object-storage
 *    endpoint host and the single selected AI host (EGRESS_AI_HOST or the host of
 *    AI_BASE_URL / OPENAI_BASE_URL / ANTHROPIC_BASE_URL). A non-HTTPS/HTTP scheme and any
 *    host not on the list are blocked with a typed EgressBlockedError. Wildcards are
 *    explicit (`*.example.com`); there is no implicit subdomain trust.
 *  - CAPS: a hard per-call byte cap (default 256 KiB) for every call, and a hard
 *    per-month AI payload byte cap (default 50 MiB) that only counts AI-category calls.
 *    The monthly counter is reserved BEFORE dispatch, so concurrent calls cannot overshoot.
 *  - TRANSPARENCY: a bounded ring buffer of exactly what the most recent calls sent -
 *    timestamp, host, method, path (query string omitted so a token in a query is never
 *    stored), category, request bytes, allowed/blocked and the reason.
 *  - TELEMETRY: unconditionally OFF. TimeMark ships no Vercel Web Analytics, no Speed
 *    Insights and no third-party scripts; `isTelemetryEnabled` always returns false and
 *    `TELEMETRY_HOSTS` is empty, so this guard can never be used to phone home.
 */

const log = createLogger('egress-guard');

export const EGRESS_ENV = {
  allowedHosts: 'EGRESS_ALLOWED_HOSTS',
  aiHost: 'EGRESS_AI_HOST',
  objectStorageEndpoint: 'OBJECT_STORAGE_ENDPOINT',
  maxCallBytes: 'EGRESS_MAX_CALL_BYTES',
  maxMonthlyAiBytes: 'EGRESS_MAX_MONTHLY_AI_BYTES',
} as const;

export const DEFAULT_MAX_CALL_BYTES = 256 * 1024; // 256 KiB hard per-call cap
export const DEFAULT_MAX_MONTHLY_AI_BYTES = 50 * 1024 * 1024; // 50 MiB per UTC month
export const DEFAULT_TRANSPARENCY_LIMIT = 50;

/**
 * Curated provider hosts used by the HTTP notification channels. EGRESS_ALLOWED_HOSTS
 * extends this list at deploy time; nothing else may be reached.
 */
export const NOTIFICATION_PROVIDER_HOSTS: readonly string[] = [
  'api.telegram.org',
  'api.resend.com',
  'hooks.slack.com',
  'discord.com',
  'discordapp.com',
  'discordapp.net',
  'open.feishu.cn',
  'open.larksuite.com',
  'qyapi.weixin.qq.com',
  'oapi.dingtalk.com',
  'chat.googleapis.com',
  'graph.microsoft.com',
  'notify-api.line.me',
  'api.mattermost.com',
  'matrix.org',
  'api.wxpusher.com',
  'pushplus.plus',
  'sctapi.ftqq.com',
  'api.pushover.net',
  'ntfy.sh',
  'api.day.app',
  'api2.pushdeer.com',
  'api.twilio.com',
  'fcm.googleapis.com',
  'push.techulus.com',
  'api.pushback.io',
  'gotify.net',
];

export const EGRESS_CATEGORIES = ['ai', 'notification', 'object_storage', 'other'] as const;
export type EgressCategory = (typeof EGRESS_CATEGORIES)[number];

export type EgressBlockCode =
  | 'EGRESS_URL_INVALID'
  | 'EGRESS_SCHEME_BLOCKED'
  | 'EGRESS_HOST_NOT_ALLOWED'
  | 'EGRESS_PAYLOAD_TOO_LARGE'
  | 'EGRESS_MONTHLY_AI_CAP_EXCEEDED';

export class EgressBlockedError extends Error {
  readonly code: EgressBlockCode;
  readonly host: string | null;
  constructor(code: EgressBlockCode, message: string, host: string | null = null) {
    super(message);
    this.name = 'EgressBlockedError';
    this.code = code;
    this.host = host;
  }
}

/** Telemetry is unconditionally OFF; no env can re-enable third-party scripts here. */
export const TELEMETRY_ENABLED = false;
export const TELEMETRY_HOSTS: readonly string[] = [];

export function isTelemetryEnabled(): boolean {
  return TELEMETRY_ENABLED;
}

export interface EgressAllowlist {
  hosts: readonly string[];
  aiHost: string | null;
  objectStorageHost: string | null;
}

export function hostOf(raw: string | null | undefined): string | null {
  if (raw == null || raw.trim() === '') return null;
  try {
    const parsed = new URL(raw.trim());
    return parsed.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Build the effective allowlist from env + explicit caller overrides. */
export function buildEgressAllowlist(options: {
  env?: NodeJS.ProcessEnv;
  extraHosts?: readonly string[];
  aiHost?: string | null;
  objectStorageEndpoint?: string | null;
} = {}): EgressAllowlist {
  const env = options.env ?? process.env;
  const hosts = new Set<string>(NOTIFICATION_PROVIDER_HOSTS);
  for (const raw of (env[EGRESS_ENV.allowedHosts] ?? '').split(',')) {
    const host = raw.trim().toLowerCase();
    if (host !== '') hosts.add(host);
  }
  for (const raw of options.extraHosts ?? []) {
    const host = raw.trim().toLowerCase();
    if (host !== '') hosts.add(host);
  }

  const objectStorageEndpoint = options.objectStorageEndpoint ?? env[EGRESS_ENV.objectStorageEndpoint] ?? null;
  const objectStorageHost = hostOf(objectStorageEndpoint);
  if (objectStorageHost !== null) hosts.add(objectStorageHost);

  const aiHost =
    options.aiHost ??
    env[EGRESS_ENV.aiHost] ??
    hostOf(env.AI_BASE_URL) ??
    hostOf(env.OPENAI_BASE_URL) ??
    hostOf(env.ANTHROPIC_BASE_URL);
  if (aiHost != null && aiHost !== '') {
    hosts.add(aiHost.toLowerCase());
  }

  return { hosts: [...hosts], aiHost: aiHost?.toLowerCase() ?? null, objectStorageHost };
}

/** Exact host match, plus explicit `*.example.com` wildcard entries only. */
export function isAllowlistedHost(host: string, allowlist: EgressAllowlist): boolean {
  for (const entry of allowlist.hosts) {
    if (entry === host) return true;
    if (entry.startsWith('*.') && host.endsWith(entry.slice(1))) return true;
  }
  return false;
}

function categoryForHost(host: string, allowlist: EgressAllowlist): EgressCategory {
  if (allowlist.aiHost !== null && host === allowlist.aiHost) return 'ai';
  if (allowlist.objectStorageHost !== null && host === allowlist.objectStorageHost) return 'object_storage';
  if (NOTIFICATION_PROVIDER_HOSTS.includes(host)) return 'notification';
  return 'other';
}

export interface EgressTransparencyRecord {
  at: string;
  host: string;
  method: string;
  /** Pathname only - the query string is deliberately omitted (it may carry a token). */
  path: string;
  category: EgressCategory;
  requestBytes: number;
  allowed: boolean;
  reason: string;
}

export interface EgressGuardOptions {
  env?: NodeJS.ProcessEnv;
  allowlist?: EgressAllowlist;
  extraNotificationHosts?: readonly string[];
  aiHost?: string | null;
  objectStorageEndpoint?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxCallBytes?: number;
  maxMonthlyAiBytes?: number;
  transparencyLimit?: number;
}

export interface EgressGuard {
  fetch(url: string, init?: RequestInit): Promise<Response>;
  transparency(): readonly EgressTransparencyRecord[];
  monthlyAiBytes(): number;
  allowlist(): EgressAllowlist;
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt((raw ?? '').trim(), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function monthKeyUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Measurable bodies only; serialize streams/FormData to string or Uint8Array to be counted. */
function requestByteLength(init: RequestInit | undefined): number {
  const body = init?.body;
  if (body == null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body, 'utf8');
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof URLSearchParams) return Buffer.byteLength(body.toString(), 'utf8');
  return 0;
}

export function createEgressGuard(options: EgressGuardOptions = {}): EgressGuard {
  const env = options.env ?? process.env;
  const allowlist =
    options.allowlist ??
    buildEgressAllowlist({
      env,
      ...(options.extraNotificationHosts === undefined ? {} : { extraHosts: options.extraNotificationHosts }),
      ...(options.aiHost === undefined ? {} : { aiHost: options.aiHost }),
      ...(options.objectStorageEndpoint === undefined ? {} : { objectStorageEndpoint: options.objectStorageEndpoint }),
    });
  const maxCallBytes = options.maxCallBytes ?? readPositiveInt(env[EGRESS_ENV.maxCallBytes], DEFAULT_MAX_CALL_BYTES);
  const maxMonthlyAiBytes =
    options.maxMonthlyAiBytes ?? readPositiveInt(env[EGRESS_ENV.maxMonthlyAiBytes], DEFAULT_MAX_MONTHLY_AI_BYTES);
  const transparencyLimit = options.transparencyLimit ?? DEFAULT_TRANSPARENCY_LIMIT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  const records: EgressTransparencyRecord[] = [];
  let aiMonth = monthKeyUtc(new Date(now()));
  let aiBytes = 0;

  function pushRecord(record: EgressTransparencyRecord): void {
    records.push(record);
    if (records.length > transparencyLimit) records.splice(0, records.length - transparencyLimit);
  }

  return {
    async fetch(url, init) {
      const nowMs = now();
      const at = new Date(nowMs).toISOString();
      const method = (init?.method ?? 'GET').toUpperCase();
      const requestBytes = requestByteLength(init);

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        pushRecord({ at, host: '', method, path: url.slice(0, 120), category: 'other', requestBytes, allowed: false, reason: 'url_invalid' });
        throw new EgressBlockedError('EGRESS_URL_INVALID', `not a valid outbound URL: ${url.slice(0, 120)}`);
      }

      const host = parsed.hostname.toLowerCase();
      const category = categoryForHost(host, allowlist);
      const baseRecord = { at, host, method, path: parsed.pathname, category, requestBytes };

      const block = (code: EgressBlockCode, reason: string, message: string): never => {
        pushRecord({ ...baseRecord, allowed: false, reason });
        log.warn({ event: 'egress.blocked', code, host, method, category, requestBytes }, message);
        throw new EgressBlockedError(code, message, host);
      };

      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        block('EGRESS_SCHEME_BLOCKED', 'scheme_blocked', `scheme '${parsed.protocol}' is not allowed for outbound calls`);
      }
      if (!isAllowlistedHost(host, allowlist)) {
        block('EGRESS_HOST_NOT_ALLOWED', 'host_not_allowed', `outbound host '${host}' is not on the egress allowlist`);
      }
      if (requestBytes > maxCallBytes) {
        block(
          'EGRESS_PAYLOAD_TOO_LARGE',
          'call_cap_exceeded',
          `outbound body of ${requestBytes} bytes exceeds the per-call cap of ${maxCallBytes}`,
        );
      }

      const currentMonth = monthKeyUtc(new Date(nowMs));
      if (currentMonth !== aiMonth) {
        aiMonth = currentMonth;
        aiBytes = 0;
      }
      if (category === 'ai' && aiBytes + requestBytes > maxMonthlyAiBytes) {
        block(
          'EGRESS_MONTHLY_AI_CAP_EXCEEDED',
          'monthly_ai_cap_exceeded',
          `AI payload would push the month (${currentMonth}) to ${aiBytes + requestBytes} bytes, over the ${maxMonthlyAiBytes}-byte cap`,
        );
      }
      if (category === 'ai') aiBytes += requestBytes; // reserve before dispatch

      pushRecord({ ...baseRecord, allowed: true, reason: 'allowed' });
      return fetchImpl(url, init);
    },

    transparency() {
      return [...records];
    },

    monthlyAiBytes() {
      return aiBytes;
    },

    allowlist() {
      return allowlist;
    },
  };
}
