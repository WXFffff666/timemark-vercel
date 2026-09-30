import { query } from '../../db/index.js';
import {
  getChannelTemplate,
  type ChannelColumn,
  type ChannelConfigMethod,
} from '../notifications/channels.config.js';
import { isSupportedChannel } from '../notifications/supported-channels.js';
import {
  getNotificationAccounts,
  updateNotificationAccount,
  type NotificationAccount,
} from '../config.service.js';
import { testConnection, type TestConnectionResult } from '../notifications/test-connection.js';
import { createLogger } from '../../utils/logger.js';
import { logAudit } from '../audit.service.js';

const log = createLogger('channel-repair');

/** The four credential columns notification_accounts actually stores. */
export const CREDENTIAL_COLUMNS = ['webhook', 'token', 'secret', 'chat_id'] as const;
export type CredentialColumn = (typeof CREDENTIAL_COLUMNS)[number];

/** Which guided step the wizard should lead with for this account. */
export type RepairStep = 'retest' | 'reenter' | 'reactivate' | 'done';

export interface CredentialShapeField {
  column: CredentialColumn;
  label: string;
  required: boolean;
  /**
   * Whether a non-empty value is stored. This is the ONLY credential fact ever
   * returned: the value, its length and a prefix are never exposed.
   */
  present: boolean;
}

export interface ChannelFailureSummary {
  /** Failed sends since the last success, plus the current failure when retesting. */
  consecutiveFailures: number;
  /** Failed sends inside the recent window (bounded at 50 rows). */
  recentFailures: number;
  /** The exact provider error from the most recent failure, credential-redacted. */
  lastError: string | null;
  lastFailureAt: string | null;
}

export interface ChannelRepairAccountView {
  id: number;
  name: string;
  type: string;
  configMethod: ChannelConfigMethod;
  isActive: boolean;
  lastTestResult: string | null;
  lastTestAt: string | null;
  connectionStatus: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelRepairDiagnosis {
  account: ChannelRepairAccountView;
  supported: boolean;
  /** The channel template's configurable fields; safe to render, never a value. */
  templateFields: Array<{ name: string; label: string; type: string; required: boolean; helpText?: string }>;
  credentials: CredentialShapeField[];
  missingRequiredColumns: CredentialColumn[];
  failures: ChannelFailureSummary;
  /** True when `is_active = FALSE` (the user still has to click enable/disable). */
  disabled: boolean;
  /** True when the notifications layer itself flipped is_active off after 3 failures. */
  autoDisabled: boolean;
  recommendedStep: RepairStep;
}

export interface ChannelRepairTestOutcome {
  accountId: number;
  success: boolean;
  message: string;
  details: string | null;
  connectionStatus: 'healthy' | 'unhealthy' | 'unknown';
  lastTestResult: 'success' | 'failed' | 'unsupported';
  testedAt: string;
  diagnosis: ChannelRepairDiagnosis;
}

export interface ReenterCredentialsResult {
  accountId: number;
  updatedColumns: CredentialColumn[];
  missingRequiredColumns: CredentialColumn[];
}

/** Service-level error carrying an HTTP status so the route can answer verbatim. */
export class ChannelRepairError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 422,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ChannelRepairError';
  }
}

function isCredentialColumn(value: string): value is CredentialColumn {
  return (CREDENTIAL_COLUMNS as readonly string[]).includes(value);
}

/** The column a template field lands in; `field.column` wins (matrix/pushover). */
function fieldColumn(name: string, explicit: ChannelColumn | undefined): CredentialColumn | null {
  if (explicit && isCredentialColumn(explicit)) return explicit;
  return isCredentialColumn(name) ? name : null;
}

/** Replace every stored credential value found in text, then cap the length. */
export function redactCredentials(text: string | null | undefined, account: NotificationAccount): string | null {
  if (!text) return null;
  let safe = text;
  for (const column of CREDENTIAL_COLUMNS) {
    const secret = account[column];
    if (typeof secret === 'string' && secret.length >= 4) {
      safe = safe.split(secret).join('[redacted]');
    }
  }
  return safe.length > 500 ? `${safe.slice(0, 500)}…` : safe;
}

function classifyTestResult(result: Pick<TestConnectionResult, 'success' | 'message'>): {
  connectionStatus: 'healthy' | 'unhealthy' | 'unknown';
  lastTestResult: 'success' | 'failed' | 'unsupported';
} {
  if (result.success) return { connectionStatus: 'healthy', lastTestResult: 'success' };
  const message = result.message ?? '';
  if (message.includes('暂不支持') || message.includes('未知的配置方式')) {
    return { connectionStatus: 'unknown', lastTestResult: 'unsupported' };
  }
  return { connectionStatus: 'unhealthy', lastTestResult: 'failed' };
}

async function findAccount(userId: number, accountId: number): Promise<NotificationAccount> {
  const accounts = await getNotificationAccounts(userId);
  const account = accounts.find((a) => a.id === accountId);
  if (!account) {
    throw new ChannelRepairError('通知渠道不存在', 404, 'channel_not_found');
  }
  return account;
}

/**
 * `connection_status` is stored as 'healthy' | 'unhealthy' | 'unknown' by the
 * channel-health cron, but the base NotificationAccount type still declares an
 * older union. Read it widened so the string comparisons stay sound.
 */
function connectionStatusOf(account: NotificationAccount): string | null {
  const raw = account.connection_status as unknown;
  return typeof raw === 'string' ? raw : null;
}

function toAccountView(account: NotificationAccount): ChannelRepairAccountView {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    configMethod: account.config_method,
    isActive: account.is_active,
    lastTestResult: (account as NotificationAccount & { last_test_result?: string | null }).last_test_result ?? null,
    lastTestAt: (account as NotificationAccount & { last_test_at?: string | null }).last_test_at ?? null,
    connectionStatus: account.connection_status ?? null,
    createdAt: account.created_at,
    updatedAt: account.updated_at,
  };
}

/** Credential SHAPE only - present/absent per template field, never a value. */
function buildCredentialShape(account: NotificationAccount): {
  credentials: CredentialShapeField[];
  missingRequiredColumns: CredentialColumn[];
} {
  const template = getChannelTemplate(account.type);
  const seen = new Set<CredentialColumn>();
  const shape: CredentialShapeField[] = [];

  for (const field of template?.fields ?? []) {
    const column = fieldColumn(field.name, field.column);
    if (!column || seen.has(column)) continue;
    seen.add(column);
    const value = account[column];
    shape.push({
      column,
      label: field.label,
      required: field.required,
      present: typeof value === 'string' && value.trim().length > 0,
    });
  }

  const missingRequiredColumns = shape
    .filter((entry) => entry.required && !entry.present)
    .map((entry) => entry.column);

  return { credentials: shape, missingRequiredColumns };
}

interface FailureRow {
  status: string;
  error_message: string | null;
  created_at: string;
}

async function loadFailures(userId: number, account: NotificationAccount): Promise<ChannelFailureSummary> {
  const result = await query(
    `SELECT status, error_message, created_at
       FROM event_trigger_logs
      WHERE user_id = $1 AND account_id = $2 AND channel_type = $3
        AND status IN ('failed', 'success')
      ORDER BY id DESC
      LIMIT 50`,
    [userId, account.id, account.type],
  );
  const rows = result.rows as FailureRow[];

  let consecutiveFailures = 0;
  let lastError: string | null = null;
  let lastFailureAt: string | null = null;
  let recentFailures = 0;
  let stillLeading = true;
  for (const row of rows) {
    if (row.status !== 'failed') {
      stillLeading = false;
      continue;
    }
    recentFailures += 1;
    if (lastError === null) {
      lastError = redactCredentials(row.error_message, account);
      lastFailureAt = row.created_at;
    }
    // Leading failures = the failures since the most recent success.
    if (stillLeading) consecutiveFailures += 1;
  }

  return { consecutiveFailures, recentFailures, lastError, lastFailureAt };
}

/** Full guided-diagnosis payload for one owned channel. Never carries a secret. */
export async function getRepairDiagnosis(userId: number, accountId: number): Promise<ChannelRepairDiagnosis> {
  const account = await findAccount(userId, accountId);
  const supported = isSupportedChannel(account.type);
  const { credentials, missingRequiredColumns } = buildCredentialShape(account);
  const failures = await loadFailures(userId, account);
  const template = getChannelTemplate(account.type);

  let recommendedStep: RepairStep;
  if (!account.is_active) recommendedStep = 'reactivate';
  else if (missingRequiredColumns.length > 0) recommendedStep = 'reenter';
  else if (connectionStatusOf(account) === 'unhealthy') recommendedStep = 'reenter';
  else recommendedStep = 'retest';

  return {
    account: toAccountView(account),
    supported,
    templateFields: (template?.fields ?? []).map((field) => ({
      name: field.name,
      label: field.label,
      type: field.type,
      required: field.required,
      helpText: field.helpText,
    })),
    credentials,
    missingRequiredColumns,
    failures,
    disabled: !account.is_active,
    autoDisabled: !account.is_active && failures.consecutiveFailures >= 3,
    recommendedStep,
  };
}

/**
 * Live re-test with the STORED credentials. The result message/details are
 * credential-redacted before they leave the process, and the outcome is
 * persisted to connection_status/last_test_result exactly like the health cron.
 */
export async function retestChannel(userId: number, accountId: number): Promise<ChannelRepairTestOutcome> {
  const account = await findAccount(userId, accountId);

  const result = await testConnection({
    type: account.type,
    configMethod: account.config_method,
    webhook: account.webhook ?? undefined,
    token: account.token ?? undefined,
    chatId: account.chat_id ?? undefined,
    secret: account.secret ?? undefined,
    sessionData: account.session_data ? JSON.stringify(account.session_data) : undefined,
  });

  const classified = classifyTestResult(result);
  const safeMessage = redactCredentials(result.message, account) ?? '测试完成';
  const safeDetails = redactCredentials(result.details ?? null, account);

  await query(
    `UPDATE notification_accounts
        SET last_test_result = $1, last_test_at = CURRENT_TIMESTAMP, connection_status = $2, updated_at = CURRENT_TIMESTAMP
      WHERE id = $3 AND user_id = $4`,
    [classified.lastTestResult, classified.connectionStatus, account.id, userId],
  ).catch(
    log.warn.bind(log, { event: 'channel_repair.test_result_persist_failed', accountId }),
  );

  await logAudit(userId, 'channel_repair.retest', 'notification_account', account.id, {
    connectionStatus: classified.connectionStatus,
    lastTestResult: classified.lastTestResult,
  });

  return {
    accountId: account.id,
    success: result.success,
    message: safeMessage,
    details: safeDetails,
    connectionStatus: classified.connectionStatus,
    lastTestResult: classified.lastTestResult,
    testedAt: new Date().toISOString(),
    diagnosis: await getRepairDiagnosis(userId, accountId),
  };
}

/** Column-keyed credential patch. Values are validated by shape, never echoed. */
export interface ReenterCredentialsInput {
  webhook?: string;
  token?: string;
  secret?: string;
  chat_id?: string;
  /** Optional: re-enable in the same click as the credential fix. */
  reactivate?: boolean;
}

/**
 * Merge a credential re-entry into the account. Only provided columns change;
 * required-field validation runs on the MERGED shape so a missing required
 * column is still caught. The stored secret is never returned.
 */
export async function reenterCredentials(
  userId: number,
  accountId: number,
  input: ReenterCredentialsInput,
): Promise<ReenterCredentialsResult> {
  const account = await findAccount(userId, accountId);
  const template = getChannelTemplate(account.type);

  const patch: Partial<Record<CredentialColumn, string>> = {};
  for (const column of CREDENTIAL_COLUMNS) {
    const raw = input[column];
    if (raw !== undefined) {
      if (typeof raw !== 'string') {
        throw new ChannelRepairError(`字段 ${column} 必须是字符串`, 400, 'invalid_credential_shape');
      }
      patch[column] = raw.trim();
    }
  }
  if (Object.keys(patch).length === 0) {
    throw new ChannelRepairError('未提供任何凭据字段', 400, 'no_credentials_provided');
  }

  // Merged shape: existing decrypted value unless this request replaces it.
  const merged: Record<CredentialColumn, string> = {
    webhook: patch.webhook ?? account.webhook ?? '',
    token: patch.token ?? account.token ?? '',
    secret: patch.secret ?? account.secret ?? '',
    chat_id: patch.chat_id ?? account.chat_id ?? '',
  };

  const seen = new Set<CredentialColumn>();
  const missingRequiredColumns: CredentialColumn[] = [];
  for (const field of template?.fields ?? []) {
    const column = fieldColumn(field.name, field.column);
    if (!column || seen.has(column)) continue;
    seen.add(column);
    if (field.required && merged[column].trim().length === 0) {
      missingRequiredColumns.push(column);
    }
  }
  if (missingRequiredColumns.length > 0) {
    throw new ChannelRepairError(
      `缺少必填字段：${missingRequiredColumns.join(', ')}`,
      422,
      'missing_required_credentials',
    );
  }

  const updated = await updateNotificationAccount(account.id, userId, {
    ...patch,
    ...(input.reactivate ? { is_active: true } : {}),
  });
  if (!updated) {
    throw new ChannelRepairError('凭据更新失败', 404, 'channel_not_found');
  }

  await logAudit(userId, 'channel_repair.reenter_credentials', 'notification_account', account.id, {
    updatedColumns: Object.keys(patch),
    reactivated: Boolean(input.reactivate),
  });

  return {
    accountId: account.id,
    updatedColumns: Object.keys(patch) as CredentialColumn[],
    missingRequiredColumns: [],
  };
}

/**
 * Explicit disable. `confirm` must be `true` - the wizard wires it to a dedicated
 * click, so the notifications layer is never turned off as a side effect.
 */
export async function setChannelActive(
  userId: number,
  accountId: number,
  active: boolean,
  confirm: boolean,
): Promise<{ accountId: number; isActive: boolean }> {
  if (!confirm) {
    throw new ChannelRepairError('需要显式确认才能更改渠道状态', 400, 'confirmation_required');
  }
  const account = await findAccount(userId, accountId);
  const updated = await updateNotificationAccount(account.id, userId, { is_active: active });
  if (!updated) {
    throw new ChannelRepairError('通知渠道不存在', 404, 'channel_not_found');
  }

  await logAudit(userId, active ? 'channel_repair.enable' : 'channel_repair.disable', 'notification_account', account.id, {
    previousActive: account.is_active,
  });

  return { accountId: account.id, isActive: active };
}

/** Accounts worth surfacing to the repair wizard: disabled, unhealthy or last test failed. */
export function needsRepair(
  account: NotificationAccount & { last_test_result?: string | null },
): boolean {
  const status = connectionStatusOf(account);
  return (
    !account.is_active ||
    account.last_test_result === 'failed' ||
    status === 'unhealthy' ||
    status === 'unknown'
  );
}

/** Lightweight list for the wizard entry point (no failure query per account). */
export async function listRepairCandidates(
  userId: number,
): Promise<Array<ChannelRepairAccountView & { lastError: string | null }>> {
  const accounts = await getNotificationAccounts(userId);
  return accounts.filter(needsRepair).map((account) => ({
    ...toAccountView(account),
    lastError: null,
  }));
}
