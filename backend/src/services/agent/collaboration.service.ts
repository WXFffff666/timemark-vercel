/**
 * Single-owner family collaboration (task 160).
 *
 * THIS IS NOT MULTI-TENANCY. There is exactly ONE owner per data set (the row
 * in `users`), and guests are NOT users: they hold an invite token, never get an
 * account, never get settings access and never see another owner's data. There
 * is no tenant/organisation/membership table - the isolation boundary is the
 * single `owner_user_id` foreign key, not a tenant id. A guest is an
 * email/link bound to one invite row.
 *
 * Invite model:
 *   - the owner invites by email/link with a ROLE (viewer | commenter | editor)
 *     and a SCOPE (profile and/or tag and/or entity types);
 *   - the raw token is shown once and never stored - only its SHA-256 hash is
 *     persisted (`collaboration_invites.token_hash`), expiring and revocable;
 *   - every collaborator change is appended to the activity feed.
 *
 * Role/scope matrix (enforced here, surfaced by the route):
 *   viewer    read the scoped surface only.
 *   commenter read + comment; cannot mutate entities.
 *   editor    read + comment + write entities inside the scope.
 * A viewer (or commenter) attempting a write gets a 403 from the route.
 *
 * Token minting/hashing and the scoped read view REUSE the shipped
 * `share.service.ts` machinery; this module only adds roles, invites and feed.
 */
import { query } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import {
  SHARE_VIEW_LIMIT,
  ShareScopeError,
  buildScopedView,
  generateShareTokenValue,
  hashShareToken,
} from './share.service.js';

const log = createLogger('collaboration');

export const COLLABORATION_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type CollaborationRole = (typeof COLLABORATION_ROLES)[number];

export const COLLABORATION_ENTITY_TYPES = ['events', 'contacts'] as const;
export type CollaborationEntityType = (typeof COLLABORATION_ENTITY_TYPES)[number];

export const COLLABORATION_DEFAULT_EXPIRY_DAYS = 30;
export const COLLABORATION_MAX_EXPIRY_DAYS = 365;

export class CollaborationNotFoundError extends Error {
  constructor() {
    super('collaboration invite not found');
    this.name = 'CollaborationNotFoundError';
  }
}

export class CollaborationForbiddenError extends Error {
  constructor(message = '没有权限执行此操作') {
    super(message);
    this.name = 'CollaborationForbiddenError';
  }
}

export class CollaborationScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationScopeError';
  }
}

export interface CollaborationScope {
  profileId: number | null;
  tag: string | null;
  /** Empty = every supported entity type for the chosen profile/tag scope. */
  entityTypes: CollaborationEntityType[];
}

export interface CollaborationPermissions {
  canRead: boolean;
  canComment: boolean;
  canEdit: boolean;
}

/** The single source of truth for the role/scope matrix. */
export function collaborationPermissions(role: CollaborationRole): CollaborationPermissions {
  return {
    canRead: true,
    canComment: role === 'commenter' || role === 'editor',
    canEdit: role === 'editor',
  };
}

export interface CreateCollaborationInviteInput {
  email?: string | null;
  label?: string | null;
  role: CollaborationRole;
  scope: {
    profileId?: number | null;
    tag?: string | null;
    entityTypes?: string[];
  };
  expiresInDays?: number | null;
}

export interface CollaborationInviteView {
  id: number;
  email: string | null;
  label: string | null;
  role: CollaborationRole;
  scope: CollaborationScope;
  expiresAt: string | null;
  revokedAt: string | null;
  acceptedAt: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string | null;
}

interface CollaborationInviteRow {
  id: number | string;
  owner_user_id: number;
  guest_email: string | null;
  role: CollaborationRole;
  scope_profile_id: number | null;
  scope_tag: string | null;
  scope_entity_types: unknown;
  token_hash: string;
  label: string | null;
  expires_at: string | Date | null;
  revoked_at: string | Date | null;
  accepted_at: string | Date | null;
  last_accessed_at: string | Date | null;
  access_count: number;
  created_at: string | Date | null;
}

export interface ResolvedCollaborationInvite {
  id: number;
  ownerUserId: number;
  role: CollaborationRole;
  permissions: CollaborationPermissions;
  scope: CollaborationScope;
  label: string | null;
}

function toIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseEntityTypes(raw: unknown): CollaborationEntityType[] {
  const source = (() => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() !== '') {
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  })();
  const allowed = COLLABORATION_ENTITY_TYPES as readonly string[];
  const out: CollaborationEntityType[] = [];
  for (const value of source) {
    const text = String(value);
    if (allowed.includes(text) && !out.includes(text as CollaborationEntityType)) {
      out.push(text as CollaborationEntityType);
    }
  }
  return out;
}

function scopeFromRow(row: CollaborationInviteRow): CollaborationScope {
  return {
    profileId: row.scope_profile_id,
    tag: row.scope_tag,
    entityTypes: parseEntityTypes(row.scope_entity_types),
  };
}

function toView(row: CollaborationInviteRow): CollaborationInviteView {
  return {
    id: Number(row.id),
    email: row.guest_email,
    label: row.label,
    role: row.role,
    scope: scopeFromRow(row),
    expiresAt: toIso(row.expires_at),
    revokedAt: toIso(row.revoked_at),
    acceptedAt: toIso(row.accepted_at),
    accessCount: row.access_count,
    lastAccessedAt: toIso(row.last_accessed_at),
    createdAt: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Invite lifecycle
// ---------------------------------------------------------------------------

async function profileBelongsToOwner(ownerUserId: number, profileId: number): Promise<boolean> {
  const result = await query('SELECT 1 FROM profiles WHERE id = $1 AND user_id = $2', [profileId, ownerUserId]);
  return result.rows.length > 0;
}

export async function createCollaborationInvite(
  ownerUserId: number,
  input: CreateCollaborationInviteInput,
): Promise<{ token: string; view: CollaborationInviteView }> {
  let profileId: number | null = null;
  let tag: string | null = null;

  if (input.scope?.profileId != null) {
    if (!(await profileBelongsToOwner(ownerUserId, input.scope.profileId))) {
      throw new CollaborationScopeError('档案不存在');
    }
    profileId = input.scope.profileId;
  }
  if (input.scope?.tag != null && String(input.scope.tag).trim() !== '') {
    tag = String(input.scope.tag).trim().slice(0, 100);
  }
  const entityTypes = parseEntityTypes(input.scope?.entityTypes);

  const days = input.expiresInDays == null
    ? COLLABORATION_DEFAULT_EXPIRY_DAYS
    : Math.min(Math.max(Math.trunc(input.expiresInDays), 1), COLLABORATION_MAX_EXPIRY_DAYS);
  const email = input.email?.trim().toLowerCase() || null;
  const raw = generateShareTokenValue();

  const result = await query(
    `INSERT INTO collaboration_invites
       (owner_user_id, guest_email, role, scope_profile_id, scope_tag, scope_entity_types, token_hash, label, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, now() + ($9 || ' days')::interval)
     RETURNING *`,
    [ownerUserId, email, input.role, profileId, tag, JSON.stringify(entityTypes), hashShareToken(raw), input.label ?? null, String(days)],
  );
  const row = result.rows[0] as CollaborationInviteRow;
  await recordCollaborationActivity(ownerUserId, {
    actorKind: 'owner',
    actorLabel: 'owner',
    inviteId: Number(row.id),
    action: 'invite_created',
    detail: { role: row.role, profileId, tag, entityTypes },
  });
  log.info({ event: 'collaboration.invite_created', ownerUserId, inviteId: Number(row.id), role: row.role }, 'collaboration invite created');
  return { token: raw, view: toView(row) };
}

export async function listCollaborationInvites(ownerUserId: number): Promise<CollaborationInviteView[]> {
  const result = await query(
    'SELECT * FROM collaboration_invites WHERE owner_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200',
    [ownerUserId],
  );
  return result.rows.map((row) => toView(row as CollaborationInviteRow));
}

export async function revokeCollaborationInvite(ownerUserId: number, id: number): Promise<boolean> {
  const result = await query(
    'UPDATE collaboration_invites SET revoked_at = now() WHERE id = $1 AND owner_user_id = $2 AND revoked_at IS NULL RETURNING id',
    [id, ownerUserId],
  );
  if (result.rows.length === 0) return false;
  await recordCollaborationActivity(ownerUserId, {
    actorKind: 'owner',
    actorLabel: 'owner',
    inviteId: id,
    action: 'invite_revoked',
  });
  return true;
}

/**
 * Resolve a raw guest token to its role + scope. Unknown, expired and revoked
 * tokens all map to the same not-found error so a token cannot be enumerated.
 */
export async function resolveCollaborationInvite(raw: string): Promise<ResolvedCollaborationInvite> {
  const result = await query('SELECT * FROM collaboration_invites WHERE token_hash = $1', [hashShareToken(raw)]);
  const row = result.rows[0] as CollaborationInviteRow | undefined;
  if (!row) throw new CollaborationNotFoundError();
  if (row.revoked_at != null) throw new CollaborationNotFoundError();
  const expiresAt = row.expires_at == null ? null : new Date(row.expires_at).getTime();
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) {
    throw new CollaborationNotFoundError();
  }

  await query(
    'UPDATE collaboration_invites SET access_count = access_count + 1, last_accessed_at = now(), accepted_at = COALESCE(accepted_at, now()) WHERE id = $1',
    [row.id],
  ).catch(() => undefined);

  return {
    id: Number(row.id),
    ownerUserId: Number(row.owner_user_id),
    role: row.role,
    permissions: collaborationPermissions(row.role),
    scope: scopeFromRow(row),
    label: row.label,
  };
}

// ---------------------------------------------------------------------------
// Role enforcement
// ---------------------------------------------------------------------------

export function assertCollaborationCanComment(invite: ResolvedCollaborationInvite): void {
  if (!invite.permissions.canComment) {
    throw new CollaborationForbiddenError('需要 commenter 或 editor 角色');
  }
}

export function assertCollaborationCanEdit(invite: ResolvedCollaborationInvite): void {
  if (!invite.permissions.canEdit) {
    throw new CollaborationForbiddenError('需要 editor 角色');
  }
}

// ---------------------------------------------------------------------------
// Scoped guest surface (no account, no tenant data, no settings)
// ---------------------------------------------------------------------------

export interface CollaborationGuestView {
  role: CollaborationRole;
  permissions: CollaborationPermissions;
  scopeLabel: string;
  scope: CollaborationScope;
  events: unknown[];
  contacts: unknown[];
}

const SUPPORTED = new Set<string>(COLLABORATION_ENTITY_TYPES);

function includesEntity(scope: CollaborationScope, entity: CollaborationEntityType): boolean {
  if (scope.entityTypes.length === 0) return SUPPORTED.has(entity);
  return scope.entityTypes.includes(entity);
}

export async function buildCollaborationGuestView(
  invite: ResolvedCollaborationInvite,
): Promise<CollaborationGuestView> {
  const { ownerUserId, scope } = invite;
  const includeEvents = includesEntity(scope, 'events');
  const includeContacts = includesEntity(scope, 'contacts');

  let scopeLabel = '家庭协作';
  let events: unknown[] = [];
  let contacts: unknown[] = [];

  if (scope.profileId != null || scope.tag != null) {
    // Reuse the shipped scoped read view (profile / tag).
    const scoped = await buildScopedView(
      ownerUserId,
      scope.profileId != null ? 'profile' : 'tag',
      scope.profileId,
      scope.tag,
      scope.tag ?? '分享',
    );
    scopeLabel = scoped.scopeLabel;
    events = includeEvents ? scoped.events : [];
    contacts = includeContacts ? scoped.contacts : [];
  } else {
    // No profile/tag: the surface is bounded by entity type only.
    if (includeEvents) {
      const rows = await query(
        `SELECT id, name, type, date, calendar_type, person_name, tags
           FROM events WHERE user_id = $1 ORDER BY date ASC, id ASC LIMIT ${SHARE_VIEW_LIMIT}`,
        [ownerUserId],
      );
      events = rows.rows;
    }
    if (includeContacts) {
      const rows = await query(
        `SELECT id, name, nickname, relationship, gender
           FROM fixed_contacts WHERE user_id = $1 ORDER BY name ASC, id ASC LIMIT ${SHARE_VIEW_LIMIT}`,
        [ownerUserId],
      );
      contacts = rows.rows;
    }
  }

  return {
    role: invite.role,
    permissions: invite.permissions,
    scopeLabel,
    scope,
    events,
    contacts,
  };
}

// ---------------------------------------------------------------------------
// Scoped guest writes (editor only) + activity feed
// ---------------------------------------------------------------------------

export interface CreateCollaboratorEventInput {
  name: string;
  type?: string;
  date: string;
  tags?: string[];
}

function inScope(invite: ResolvedCollaborationInvite, tags: string[]): boolean {
  if (invite.scope.tag != null && !tags.includes(invite.scope.tag)) return false;
  return true;
}

/** Editor-only event create inside the invite scope. A viewer/commenter throws 403. */
export async function createCollaboratorEvent(
  invite: ResolvedCollaborationInvite,
  input: CreateCollaboratorEventInput,
): Promise<{ id: number }> {
  assertCollaborationCanEdit(invite);
  const tags = (input.tags ?? []).map((t) => t.trim()).filter((t) => t !== '').slice(0, 50);
  if (!inScope(invite, tags)) {
    throw new CollaborationForbiddenError('超出邀请范围');
  }
  const result = await query(
    `INSERT INTO events (user_id, name, type, date, calendar_type, reminder_config, profile_id, tags)
     VALUES ($1, $2, $3, $4, 'gregorian', $5::jsonb, $6, $7::jsonb)
     RETURNING id`,
    [
      invite.ownerUserId,
      input.name,
      input.type ?? 'other',
      input.date,
      JSON.stringify({ enabled: false, daysBeforeList: [], emailRecipients: [], channels: [], accountIds: [], importSource: 'collaboration' }),
      invite.scope.profileId,
      JSON.stringify(tags),
    ],
  );
  const id = Number((result.rows[0] as { id: number | string }).id);
  await recordCollaborationActivity(invite.ownerUserId, {
    actorKind: 'guest',
    actorLabel: invite.label ?? `invite:${invite.id}`,
    inviteId: invite.id,
    action: 'guest_event_created',
    entityType: 'events',
    entityId: id,
    detail: { role: invite.role },
  });
  return { id };
}

export interface RecordCollaborationActivityInput {
  actorKind: 'owner' | 'guest';
  actorLabel?: string | null;
  inviteId?: number | null;
  action: string;
  entityType?: string | null;
  entityId?: string | number | null;
  detail?: Record<string, unknown>;
}

export async function recordCollaborationActivity(
  ownerUserId: number,
  input: RecordCollaborationActivityInput,
): Promise<void> {
  await query(
    `INSERT INTO collaboration_activity
       (owner_user_id, actor_kind, actor_label, invite_id, action, entity_type, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      ownerUserId,
      input.actorKind,
      input.actorLabel ?? null,
      input.inviteId ?? null,
      input.action,
      input.entityType ?? null,
      input.entityId != null ? String(input.entityId) : null,
      JSON.stringify(input.detail ?? {}),
    ],
  ).catch((error) => {
    log.warn({ event: 'collaboration.activity_failed', ownerUserId, err: error }, 'failed to record collaboration activity');
  });
}

export interface CollaborationActivityView {
  id: number;
  actorKind: 'owner' | 'guest';
  actorLabel: string | null;
  inviteId: number | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  detail: unknown;
  createdAt: string | null;
}

interface CollaborationActivityRow {
  id: number | string;
  actor_kind: 'owner' | 'guest';
  actor_label: string | null;
  invite_id: number | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: unknown;
  created_at: string | Date | null;
}

export async function listCollaborationActivity(ownerUserId: number): Promise<CollaborationActivityView[]> {
  const result = await query(
    `SELECT id, actor_kind, actor_label, invite_id, action, entity_type, entity_id, detail, created_at
       FROM collaboration_activity WHERE owner_user_id = $1 ORDER BY created_at DESC, id DESC LIMIT 200`,
    [ownerUserId],
  );
  return (result.rows as CollaborationActivityRow[]).map((row) => ({
    id: Number(row.id),
    actorKind: row.actor_kind,
    actorLabel: row.actor_label,
    inviteId: row.invite_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    detail: row.detail,
    createdAt: toIso(row.created_at),
  }));
}

/**
 * Documented, non-negotiable boundary: there is no second owner. A caller that
 * tries to resolve a collaboration invite as a tenant/membership context must be
 * told this is a single-owner model.
 */
export const COLLABORATION_MODEL = 'single-owner' as const;
export const COLLABORATION_IS_MULTI_TENANT = false;

export function describeCollaborationModel(): string {
  return 'Single-owner, invite-only collaboration. Guests are token holders, not users; no tenants, no memberships, no cross-owner data.';
}

/** Kept so the share module's own error type can be re-exported for route handling. */
export { ShareScopeError };
