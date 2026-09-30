/**
 * Remote backup routes (task 149) - default-exported Hono router, session-authed.
 *
 *   GET    /api/remote-backup           -> redacted config + attempt history
 *   PUT    /api/remote-backup/config    -> configure WebDAV / S3 target
 *   DELETE /api/remote-backup/config    -> remove the target
 *   POST   /api/remote-backup/run       -> manual backup (supports dryRun)
 *   GET    /api/remote-backup/backups   -> list remote objects
 *   POST   /api/remote-backup/restore   -> restore one object (supports dryRun)
 *
 * Credentials are never echoed: the config GET returns `hasSecret` only, and no
 * handler logs a config object.
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.middleware.js';
import type { User } from '@timemark/shared';
import { formatZodError } from '@timemark/shared';
import {
  REMOTE_BACKUP_MAX_RETENTION,
  RemoteBackupConfigError,
  RemoteBackupDisabledError,
  RemoteBackupEgressError,
  RemoteBackupPayloadError,
  RemoteBackupTargetError,
  deleteRemoteBackupConfig,
  getRemoteBackupConfigView,
  listRemoteBackupRecords,
  listRemoteBackups,
  restoreRemoteBackup,
  runRemoteBackup,
  saveRemoteBackupConfig,
} from '../services/agent/remote-backup.service.js';

const remoteBackup = new Hono<{ Variables: { user: User } }>();
remoteBackup.use('*', authMiddleware);

const configSchema = z
  .object({
    targetType: z.enum(['webdav', 's3']),
    endpoint: z.string().trim().min(1).max(2048),
    pathPrefix: z.string().trim().max(512).nullish(),
    bucket: z.string().trim().max(255).nullish(),
    region: z.string().trim().max(64).nullish(),
    username: z.string().trim().max(255).nullish(),
    password: z.string().max(1024).nullish(),
    accessKeyId: z.string().trim().max(255).nullish(),
    secretKey: z.string().max(1024).nullish(),
    retentionCount: z.number().int().min(0).max(REMOTE_BACKUP_MAX_RETENTION).nullish(),
    enabled: z.boolean().nullish(),
  })
  .strict();

const runSchema = z
  .object({
    dryRun: z.boolean().optional(),
    retentionCount: z.number().int().min(0).max(REMOTE_BACKUP_MAX_RETENTION).optional(),
  })
  .strict();

const restoreSchema = z
  .object({
    key: z.string().trim().min(1).max(2048),
    dryRun: z.boolean().optional(),
  })
  .strict();

/** Map a typed service error to a stable HTTP status. */
function mapError(c: Context, error: unknown): Response {
  if (error instanceof RemoteBackupConfigError) {
    return c.json({ success: false, error: error.message, code: 'config_error' }, 400);
  }
  if (error instanceof RemoteBackupDisabledError) {
    return c.json({ success: false, error: '备份目标已禁用', code: 'disabled' }, 409);
  }
  if (error instanceof RemoteBackupEgressError) {
    return c.json({ success: false, error: error.message, code: 'egress_blocked' }, 403);
  }
  if (error instanceof RemoteBackupTargetError) {
    return c.json({ success: false, error: error.message, code: 'target_error' }, 502);
  }
  if (error instanceof RemoteBackupPayloadError) {
    return c.json({ success: false, error: error.message, code: 'payload_error' }, 400);
  }
  throw error;
}

remoteBackup.get('/', async (c) => {
  const userId = Number(c.get('user').id);
  const [config, records] = await Promise.all([
    getRemoteBackupConfigView(userId),
    listRemoteBackupRecords(userId, 50),
  ]);
  return c.json({ success: true, data: { config, records } });
});

remoteBackup.put('/config', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const view = await saveRemoteBackupConfig(userId, parsed.data);
    return c.json({ success: true, data: view });
  } catch (error) {
    return mapError(c, error);
  }
});

remoteBackup.delete('/config', async (c) => {
  const userId = Number(c.get('user').id);
  const removed = await deleteRemoteBackupConfig(userId);
  if (!removed) return c.json({ success: false, error: '尚未配置备份目标' }, 404);
  return c.json({ success: true });
});

remoteBackup.post('/run', async (c) => {
  const userId = Number(c.get('user').id);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = runSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const result = await runRemoteBackup(userId, parsed.data);
    return c.json({ success: true, data: result });
  } catch (error) {
    return mapError(c, error);
  }
});

remoteBackup.get('/backups', async (c) => {
  const userId = Number(c.get('user').id);
  try {
    const data = await listRemoteBackups(userId);
    return c.json({ success: true, data });
  } catch (error) {
    return mapError(c, error);
  }
});

remoteBackup.post('/restore', async (c) => {
  const userId = Number(c.get('user').id);
  const body = await c.req.json().catch(() => null);
  const parsed = restoreSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ success: false, error: formatZodError(parsed.error), details: z.flattenError(parsed.error) }, 400);
  }
  try {
    const result = await restoreRemoteBackup(userId, parsed.data);
    return c.json({ success: true, data: result });
  } catch (error) {
    return mapError(c, error);
  }
});

export default remoteBackup;
