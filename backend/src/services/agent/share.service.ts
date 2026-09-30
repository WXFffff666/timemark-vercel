/**
 * Read-only family sharing (task 148).
 *
 * A share token is scoped to EXACTLY one profile or one tag, may expire and may
 * carry an optional passcode. The raw token is high-entropy (256-bit, base64url)
 * and is shown once: only its SHA-256 hash is persisted (`share_tokens.token_hash`).
 * A passcode is likewise stored only as a SHA-256 hash. Revocation is a soft
 * delete (`revoked_at`) so the attempt history survives.
 *
 * The public read surface is deliberately narrow: only the scoped events and
 * contacts are returned, with no secrets (no reminder config, no notification
 * channels, no share tokens, no contact email/phone). Every failure mode maps to
 * a single 404 (handled in the route) so a token cannot be enumerated.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const log = createLogger('share');

/** 32 random bytes = 256 bits of entropy. */
const TOKEN_BYTES = 32;
export const SHARE_DEFAULT_EXPIRY_DAYS = 30;
export const SHARE_MAX_EXPIRY_DAYS = 365;
export const SHARE_VIEW_LIMIT = 500;

export type ShareScopeType = 'profile' | 'tag' | 'household_list';

export class ShareScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareScopeError';
  }
}

export class ShareNotFoundError extends Error {
  constructor() {
    super('share token not found');
    this.name = 'ShareNotFoundError';
  }
}

export class SharePasscodeRequiredError extends Error {
  constructor() {
    super('share passcode required');
    this.name = 'SharePasscodeRequiredError';
  }
}

export class SharePasscodeInvalidError extends Error {
  constructor() {
    super('share passcode invalid');
    this.name = 'SharePasscodeInvalidError';
  }
}

/** Mint a raw token value; callers MUST show it once and never store the raw form. */
export function generateShareTokenValue(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 (hex) - the only representation of the token that is ever persisted. */
export function hashShareToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function hashSharePasscode(passcode: string): string {
  return createHash('sha256').update(passcode).digest('hex');
}

export interface CreateShareTokenInput {
  scopeType: ShareScopeType;
  profileId?: number | null;
  tag?: string | null;
  /** Present when scopeType = 'household_list' (ownership checked in the service). */
  listId?: number | null;
  label?: string | null;
  expiresInDays?: number | null;
  passcode?: string | null;
}

export interface ShareTokenView {
  id: number;
  scopeType: ShareScopeType;
  profileId: number | null;
  tag: string | null;
  listId: number | null;
  label: string | null;
  hasPasscode: boolean;
  expiresAt: string | null;
  revokedAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string | null;
}

interface ShareTokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  scope_type: ShareScopeType;
  scope_profile_id: number | null;
  scope_tag: string | null;
  scope_list_id: number | string | null;
  label: string | null;
  passcode_hash: string | null;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  last_accessed_at: string | Date | null;
  access_count: number;
  created_at: string | Date | null;
}

function toIso(value: string | Date | null): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toView(row: ShareTokenRow): ShareTokenView {
  return {
    id: row.id,
    scopeType: row.scope_type,
    profileId: row.scope_profile_id,
    tag: row.scope_tag,
    listId: row.scope_list_id == null ? null : Number(row.scope_list_id),
    label: row.label,
    hasPasscode: row.passcode_hash != null && row.passcode_hash !== '',
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    accessCount: row.access_count,
    lastAccessedAt: toIso(row.last_accessed_at),
    createdAt: toIso(row.created_at),
  };
}

async function profileBelongsToUser(userId: number, profileId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [profileId, userId]);
  return result.rows.length > 0;
}

async function listBelongsToUser(userId: number, listId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM household_lists WHERE id = $1 AND user_id = $2', [listId, userId]);
  return result.rows.length > 0;
}

/** Create a scoped share token; returns the raw value exactly once. */
export async function createShareToken(
  userId: number,
  input: CreateShareTokenInput,
): Promise<{ token: string; view: ShareTokenView }> {
  const scopeType = input.scopeType;
  let profileId: number | null = null;
  let tag: string | null = null;
  let listId: number | null = null;

  if (scopeType === 'profile') {
    if (input.profileId == null || !(await profileBelongsToUser(userId, input.profileId))) {
      throw new ShareScopeError('档案不存在');
    }
    profileId = input.profileId;
  } else if (scopeType === 'tag') {
    const trimmed = (input.tag ?? '').trim();
    if (!trimmed) throw new ShareScopeError('标签不能为空');
    tag = trimmed.slice(0, 100);
  } else if (scopeType === 'household_list') {
    if (input.listId == null || !(await listBelongsToUser(userId, input.listId))) {
      throw new ShareScopeError('清单不存在');
    }
    listId = input.listId;
  } else {
    throw new ShareScopeError('未知的分享范围');
  }

  const days = input.expiresInDays == null
    ? SHARE_DEFAULT_EXPIRY_DAYS
    : Math.min(Math.max(Math.trunc(input.expiresInDays), 1), SHARE_MAX_EXPIRY_DAYS);
  const passcode = input.passcode == null ? null : input.passcode.trim();
  const passcodeHash = passcode ? hashSharePasscode(passcode) : null;

  const raw = generateShareTokenValue();
  const result = await query(
    `INSERT INTO share_tokens
       (user_id, token_hash, scope_type, scope_profile_id, scope_tag, scope_list_id, label, passcode_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' days')::interval)
     RETURNING *`,
    [userId, hashShareToken(raw), scopeType, profileId, tag, listId, input.label ?? null, passcodeHash, String(days)],
  );
  const row = result.rows[0] as ShareTokenRow;
  log.info({ event: 'share.created', userId, scopeType }, 'share token created');
  return { token: raw, view: toView(row) };
}

export async function listShareTokens(userId: number): Promise<ShareTokenView[]> {
  const result = await query(
    'SELECT * FROM share_tokens WHERE user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200',
    [userId],
  );
  return result.rows.map((row) => toView(row as ShareTokenRow));
}

export async function revokeShareToken(userId: number, id: number): Promise<boolean> {
  const result = await query(
    'UPDATE share_tokens SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL RETURNING id',
    [id, userId],
  );
  return result.rows.length > 0;
}

export interface SharedEvent {
  id: number;
  name: string;
  type: string;
  date: string;
  calendar_type: string | null;
  person_name: string | null;
  tags: unknown;
}

export interface SharedContact {
  id: number;
  name: string;
  nickname: string | null;
  relationship: string | null;
  gender: string | null;
}

export interface SharedListItem {
  id: number;
  name: string;
  quantity: string;
  note: string;
  assignee: string;
  checked: boolean;
}

export interface ScopedShareView {
  scopeType: ShareScopeType;
  scopeLabel: string;
  events: SharedEvent[];
  contacts: SharedContact[];
  /** household_list scope only; always present (empty array for profile/tag). */
  listItems: SharedListItem[];
}

const EVENT_COLUMNS = 'id, name, type, date, calendar_type, person_name, tags';
const CONTACT_COLUMNS = 'id, name, nickname, relationship, gender';

/** Build the read-only view for a scope. Tag scope covers events only. */
export async function buildScopedView(
  userId: number,
  scopeType: ShareScopeType,
  profileId: number | null,
  tag: string | null,
  scopeLabel: string,
  listId: number | null = null,
): Promise<ScopedShareView> {
  if (scopeType === 'profile') {
    const [events, contacts] = await Promise.all([
      query(
        `SELECT ${EVENT_COLUMNS} FROM events WHERE user_id = $1 AND profile_id = $2 ORDER BY date ASC, id ASC LIMIT ${SHARE_VIEW_LIMIT}`,
        [userId, profileId],
      ),
      query(
        `SELECT ${CONTACT_COLUMNS} FROM fixed_contacts WHERE user_id = $1 AND profile_id = $2 ORDER BY name ASC, id ASC LIMIT ${SHARE_VIEW_LIMIT}`,
        [userId, profileId],
      ),
    ]);
    return {
      scopeType,
      scopeLabel,
      events: events.rows as SharedEvent[],
      contacts: contacts.rows as SharedContact[],
      listItems: [],
    };
  }

  if (scopeType === 'household_list') {
    const items = await query(
      `SELECT id, name, quantity, note, assignee, checked FROM household_list_items
       WHERE list_id = $1 ORDER BY checked ASC, created_at ASC, id ASC LIMIT ${SHARE_VIEW_LIMIT}`,
      [listId],
    );
    return {
      scopeType,
      scopeLabel,
      events: [],
      contacts: [],
      listItems: items.rows as SharedListItem[],
    };
  }

  // Tag scope: events carry a JSONB `tags` array; fixed_contacts has no tag
  // column, so a tag share exposes events only.
  const events = await query(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE user_id = $1 AND tags @> $2::jsonb ORDER BY date ASC, id ASC LIMIT ${SHARE_VIEW_LIMIT}`,
    [userId, JSON.stringify([tag])],
  );
  return { scopeType, scopeLabel, events: events.rows as SharedEvent[], contacts: [], listItems: [] };
}

export interface ResolvedShare {
  id: number;
  view: ScopedShareView;
}

/**
 * Resolve a raw token (+ optional passcode) to its scoped view. Throws
 * `ShareNotFoundError` for unknown/expired/revoked tokens and a passcode error
 * for a hash mismatch so the route can distinguish 404 from 401.
 */
export async function resolveShareToken(raw: string, passcode?: string | null): Promise<ResolvedShare> {
  const result = await query('SELECT * FROM share_tokens WHERE token_hash = $1', [hashShareToken(raw)]);
  const row = result.rows[0] as ShareTokenRow | undefined;
  if (!row) throw new ShareNotFoundError();

  if (row.revoked_at != null) throw new ShareNotFoundError();
  const expiresAt = row.expires_at == null ? null : new Date(row.expires_at).getTime();
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new ShareNotFoundError();
  }

  if (row.passcode_hash != null && row.passcode_hash !== '') {
    if (!passcode) throw new SharePasscodeRequiredError();
    const provided = Buffer.from(hashSharePasscode(passcode), 'hex');
    const expected = Buffer.from(row.passcode_hash, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      throw new SharePasscodeInvalidError();
    }
  }

  let scopeLabel = '分享';
  if (row.scope_type === 'profile' && row.scope_profile_id != null) {
    const profile = await query('SELECT name FROM profiles WHERE id = $1 AND user_id = $2', [row.scope_profile_id, row.user_id]);
    if (profile.rows[0]?.name) scopeLabel = String(profile.rows[0].name);
  } else if (row.scope_type === 'tag' && row.scope_tag) {
    scopeLabel = row.scope_tag;
  } else if (row.scope_type === 'household_list' && row.scope_list_id != null) {
    const list = await query('SELECT name FROM household_lists WHERE id = $1 AND user_id = $2', [
      row.scope_list_id,
      row.user_id,
    ]);
    if (list.rows[0]?.name) scopeLabel = String(list.rows[0].name);
  }

  const view = await buildScopedView(
    row.user_id,
    row.scope_type,
    row.scope_profile_id,
    row.scope_tag,
    scopeLabel,
    row.scope_list_id == null ? null : Number(row.scope_list_id),
  );

  // Best-effort usage counters - never let a counter failure break a read.
  await query(
    'UPDATE share_tokens SET access_count = access_count + 1, last_accessed_at = now() WHERE id = $1',
    [row.id],
  ).catch(() => undefined);

  return { id: row.id, view };
}
