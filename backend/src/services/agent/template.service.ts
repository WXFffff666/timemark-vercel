/**
 * 重复「例行模板」（task 140）：把一整套 routine 当作一个可实例化的对象。
 *
 * 一个模板（routine_template）= 命名的一组步骤（routine_template_steps）。步骤有四种：
 *   - event       普通事件（写 events 表）
 *   - todo        清单事项——本应用没有独立 todos 表，待办就是「进入提醒窗口的事件」
 *                 （见 todo.service.ts / routes/todos.ts 的完成语义），所以 todo 步骤
 *                 同样写 events 表（type='other'），从而能被 /api/todos/complete 打勾。
 *   - habit       习惯：habitId 关联既有习惯（linkage），或按内联规格新建
 *   - maintenance 保养计划：maintenancePlanId 关联既有计划，或按内联规格新建
 *
 * 幂等实例化：`instantiateTemplate()` 先占位 `routine_template_instances`
 * （UNIQUE(user_id, template_id, slot_key)）。同一 slot 的第二次调用（双击、重试）
 * 命中唯一键后不会再次创建任何条目，而是返回 already_instantiated。
 * slot_key 缺省 = anchorDate（用户时区的今天），因此「一天一次」是默认行为；
 * 调用方也可显式传 slot（例如 '2026-10'）表达「每月一次报表」之类的槽位。
 *
 * 全部条目在同一个事务里创建：要么整套成功（含实例占位），要么整套回滚——
 * 中途失败不会留下半套 routine，重试也仍受唯一键保护。
 */
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../../db/index.js';
import { dateStringInTimeZone, shiftCalendarDays } from '@timemark/shared/habit-schedule';

export const TEMPLATE_STEP_KINDS = ['event', 'todo', 'habit', 'maintenance'] as const;
export type TemplateStepKind = (typeof TEMPLATE_STEP_KINDS)[number];

/** createEvent 的静态默认提前天数（事件步骤缺省值）。 */
export const DEFAULT_LEAD_DAYS = [1, 3, 7];
/** 清单待办只在当天提醒（待办窗口即事件的提醒窗口）。 */
export const DEFAULT_TODO_LEAD_DAYS = [0];
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';
const MAX_SLOT_LENGTH = 64;

export interface TemplateReminderInput {
  enabled?: boolean;
  daysBeforeList?: number[];
  reminderTimes?: string[];
  channels?: string[];
  emailRecipients?: string[];
}

export interface TemplateRecurringInput {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval?: number;
  endType?: 'never' | 'count' | 'date';
  endCount?: number;
  endDate?: string;
}

export interface TemplateHabitSpec {
  icon?: string | null;
  targetPerPeriod?: number;
  period?: 'day' | 'week';
  scheduleDays?: number[];
  reminderTimes?: string[];
  color?: string | null;
}

export interface TemplateMaintenanceSpec {
  assetKind?: string;
  intervalDays?: number;
  intervalUsage?: number;
  usageUnit?: string;
  notes?: string;
}

export interface TemplateStepInput {
  kind: TemplateStepKind;
  title: string;
  position?: number;
  profileId?: number | null;
  /** 相对实例化锚点日期的偏移天数（可为负）；缺省 0 */
  dateOffsetDays?: number;
  /** event 步骤：事件类型，缺省 'other' */
  eventType?: string;
  calendarType?: 'gregorian' | 'lunar';
  reminder?: TemplateReminderInput;
  recurring?: TemplateRecurringInput;
  /** habit 步骤：关联既有习惯 */
  habitId?: number;
  /** habit 步骤：内联新建（name 缺省用步骤标题） */
  habit?: TemplateHabitSpec;
  /** maintenance 步骤：关联既有保养计划 */
  maintenancePlanId?: number;
  /** maintenance 步骤：内联新建（assetName 缺省用步骤标题） */
  maintenance?: TemplateMaintenanceSpec;
}

export interface CreateTemplateInput {
  name: string;
  description?: string | null;
  steps: TemplateStepInput[];
  isBuiltin?: boolean;
}

export interface RoutineTemplateStep {
  id: number;
  template_id: number;
  position: number;
  kind: TemplateStepKind;
  title: string;
  payload: Record<string, unknown>;
  created_at: string | null;
}

export interface RoutineTemplate {
  id: number;
  user_id: number;
  name: string;
  description: string | null;
  is_builtin: boolean;
  created_at: string | null;
  updated_at: string | null;
  steps: RoutineTemplateStep[];
}

export type TemplateEntityType = 'event' | 'habit' | 'maintenance';

export interface InstantiateReportItem {
  stepId: number;
  kind: TemplateStepKind;
  title: string;
  status: 'created' | 'linked';
  entityType: TemplateEntityType;
  entityId: number;
}

export interface InstantiateOptions {
  slot?: string | null;
  anchorDate?: string | null;
  profileId?: number | null;
}

export type TemplateInstantiateResult =
  | {
      status: 'ok';
      instanceId: number;
      slotKey: string;
      anchorDate: string;
      report: InstantiateReportItem[];
    }
  | {
      status: 'already_instantiated';
      instanceId: number;
      slotKey: string;
      anchorDate: string;
      createdAt: string | null;
    }
  | { status: 'not_found' }
  | { status: 'invalid_anchor' };

/** 某个步骤无法实例化（关联的习惯/计划不存在或不属于该用户、日期偏移非法等）。 */
export class TemplateStepError extends Error {
  constructor(
    message: string,
    readonly stepId: number,
    readonly stepKind: TemplateStepKind,
  ) {
    super(message);
    this.name = 'TemplateStepError';
  }
}

type RawRow = Record<string, unknown>;

function isStepKind(value: unknown): value is TemplateStepKind {
  return (TEMPLATE_STEP_KINDS as readonly string[]).includes(String(value));
}

function toIsoOrNull(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function toPositiveIntOrNull(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function parseJsonObject(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !(raw instanceof Date)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 落回空对象：坏 JSON 不阻塞整条模板的序列化
    }
  }
  return {};
}

function serializeStep(row: RawRow): RoutineTemplateStep {
  return {
    id: Number(row.id),
    template_id: Number(row.template_id),
    position: Number(row.position ?? 0),
    kind: isStepKind(row.kind) ? row.kind : 'event',
    title: String(row.title ?? ''),
    payload: parseJsonObject(row.payload),
    created_at: toIsoOrNull(row.created_at),
  };
}

function serializeTemplate(row: RawRow, steps: RoutineTemplateStep[]): RoutineTemplate {
  return {
    id: Number(row.id),
    user_id: Number(row.user_id),
    name: String(row.name ?? ''),
    description: row.description == null ? null : String(row.description),
    is_builtin: row.is_builtin === true,
    created_at: toIsoOrNull(row.created_at),
    updated_at: toIsoOrNull(row.updated_at),
    steps,
  };
}

async function getUserTimezone(userId: number): Promise<string> {
  const result = await query('SELECT timezone FROM user_configs WHERE user_id = $1', [userId]);
  const tz = result.rows[0]?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz.trim() : DEFAULT_TIMEZONE;
}

async function loadStepsByTemplate(
  templateIds: number[],
): Promise<Map<number, RoutineTemplateStep[]>> {
  const byTemplate = new Map<number, RoutineTemplateStep[]>();
  if (templateIds.length === 0) return byTemplate;
  const result = await query(
    `SELECT * FROM routine_template_steps
      WHERE template_id = ANY($1::int[])
      ORDER BY template_id ASC, position ASC, id ASC`,
    [templateIds],
  );
  for (const row of result.rows as RawRow[]) {
    const step = serializeStep(row);
    const list = byTemplate.get(step.template_id);
    if (list) list.push(step);
    else byTemplate.set(step.template_id, [step]);
  }
  return byTemplate;
}

export async function listTemplates(userId: number): Promise<RoutineTemplate[]> {
  const result = await query(
    `SELECT * FROM routine_templates WHERE user_id = $1
      ORDER BY is_builtin DESC, name ASC, id ASC`,
    [userId],
  );
  const rows = result.rows as RawRow[];
  if (rows.length === 0) return [];
  const byTemplate = await loadStepsByTemplate(rows.map((row) => Number(row.id)));
  return rows.map((row) => serializeTemplate(row, byTemplate.get(Number(row.id)) ?? []));
}

export async function getTemplate(userId: number, id: number): Promise<RoutineTemplate | null> {
  const result = await query('SELECT * FROM routine_templates WHERE id = $1 AND user_id = $2', [id, userId]);
  const row = result.rows[0] as RawRow | undefined;
  if (!row) return null;
  const byTemplate = await loadStepsByTemplate([id]);
  return serializeTemplate(row, byTemplate.get(id) ?? []);
}

/** 把路由层校验过的步骤拆成「列 + payload」，payload 不含 kind/title/position。 */
function normalizeStepPayload(step: TemplateStepInput): Record<string, unknown> {
  const { kind: _kind, title: _title, position: _position, ...payload } = step;
  return payload;
}

async function insertSteps(
  client: PoolClient,
  templateId: number,
  steps: TemplateStepInput[],
): Promise<RoutineTemplateStep[]> {
  const created: RoutineTemplateStep[] = [];
  for (const [index, step] of steps.entries()) {
    const inserted = await client.query(
      `INSERT INTO routine_template_steps (template_id, position, kind, title, payload)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [templateId, step.position ?? index, step.kind, step.title, JSON.stringify(normalizeStepPayload(step))],
    );
    created.push(serializeStep(inserted.rows[0] as RawRow));
  }
  return created;
}

export async function createTemplate(userId: number, input: CreateTemplateInput): Promise<RoutineTemplate> {
  return withTransaction(async (client) => {
    const inserted = await client.query(
      `INSERT INTO routine_templates (user_id, name, description, is_builtin)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, input.name, input.description ?? null, input.isBuiltin ?? false],
    );
    const row = inserted.rows[0] as RawRow;
    const steps = await insertSteps(client, Number(row.id), input.steps);
    return serializeTemplate(row, steps);
  });
}

export async function deleteTemplate(userId: number, id: number): Promise<boolean> {
  const result = await query('DELETE FROM routine_templates WHERE id = $1 AND user_id = $2 RETURNING id', [
    id,
    userId,
  ]);
  return result.rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* 内置模板（task 140 点名的三类场景）                                  */
/* ------------------------------------------------------------------ */

export const ROUTINE_TEMPLATE_PRESETS: CreateTemplateInput[] = [
  {
    name: '每周大扫除',
    description: '每周一次的全屋清洁：一个重复事件 + 分区清单',
    steps: [
      {
        kind: 'event',
        title: '每周大扫除',
        eventType: 'other',
        dateOffsetDays: 0,
        reminder: { daysBeforeList: [0], reminderTimes: ['09:00'] },
        recurring: { frequency: 'weekly', interval: 1, endType: 'never' },
      },
      { kind: 'todo', title: '厨房深度清洁', dateOffsetDays: 0 },
      { kind: 'todo', title: '卫生间除垢', dateOffsetDays: 0 },
      { kind: 'todo', title: '地板吸尘 + 拖地', dateOffsetDays: 0 },
    ],
  },
  {
    name: '旅行准备',
    description: '出发前一周的倒计时清单',
    steps: [
      {
        kind: 'event',
        title: '出发',
        eventType: 'travel',
        dateOffsetDays: 7,
        reminder: { daysBeforeList: [1, 3, 7], reminderTimes: ['09:00'] },
      },
      { kind: 'todo', title: '订机票 / 车票', dateOffsetDays: 1 },
      { kind: 'todo', title: '收拾行李', dateOffsetDays: 6 },
      { kind: 'todo', title: '关好水电门窗', dateOffsetDays: 7 },
    ],
  },
  {
    name: '月度报表',
    description: '月底汇总、复核并提交月度报表',
    steps: [
      {
        kind: 'event',
        title: '提交月度报表',
        eventType: 'deadline',
        dateOffsetDays: 0,
        reminder: { daysBeforeList: [1], reminderTimes: ['09:00'] },
        recurring: { frequency: 'monthly', interval: 1, endType: 'never' },
      },
      { kind: 'todo', title: '汇总本月数据', dateOffsetDays: -2 },
      { kind: 'todo', title: '复核报表数字', dateOffsetDays: -1 },
    ],
  },
];

/**
 * 幂等地为用户写入内置模板（ON CONFLICT (user_id, name) DO NOTHING）。
 * 已存在的同名模板（用户自己改过的）原样保留，只补缺失的。
 */
export async function seedDefaultTemplates(userId: number): Promise<{ created: string[]; skipped: string[] }> {
  return withTransaction(async (client) => {
    const created: string[] = [];
    const skipped: string[] = [];
    for (const preset of ROUTINE_TEMPLATE_PRESETS) {
      const inserted = await client.query(
        `INSERT INTO routine_templates (user_id, name, description, is_builtin)
         VALUES ($1, $2, $3, TRUE)
         ON CONFLICT (user_id, name) DO NOTHING
         RETURNING id`,
        [userId, preset.name, preset.description ?? null],
      );
      const row = inserted.rows[0] as RawRow | undefined;
      if (!row) {
        skipped.push(preset.name);
        continue;
      }
      await insertSteps(client, Number(row.id), preset.steps);
      created.push(preset.name);
    }
    return { created, skipped };
  });
}

/* ------------------------------------------------------------------ */
/* 实例化                                                              */
/* ------------------------------------------------------------------ */

function itemDate(anchorDate: string, step: RoutineTemplateStep, payload: Record<string, unknown>): string {
  const offsetRaw = payload.dateOffsetDays;
  const offset = typeof offsetRaw === 'number' && Number.isSafeInteger(offsetRaw) ? offsetRaw : 0;
  const date = shiftCalendarDays(anchorDate, offset);
  if (!date) {
    throw new TemplateStepError(`无效的日期偏移: ${String(offsetRaw)}`, step.id, step.kind);
  }
  return date;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((v) => String(v)).filter((v) => v.trim() !== '') : [];
}

function numberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => Number(v))
    .filter((n) => Number.isSafeInteger(n) && n >= 0 && n <= 3650);
}

function timeArray(value: unknown): string[] {
  return stringArray(value).filter((v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v));
}

/** todo 步骤 = 一个进入提醒窗口的事件（本应用的待办完成记录挂在 event 上）。 */
function insertEventItem(
  client: PoolClient,
  userId: number,
  profileId: number | null,
  params: {
    name: string;
    type: string;
    date: string;
    calendarType: string;
    leadDays: number[];
    reminder: Record<string, unknown>;
    recurring: Record<string, unknown> | null;
  },
): Promise<number> {
  const reminderConfig = {
    enabled: params.reminder.enabled !== false,
    daysBeforeList: params.leadDays,
    emailRecipients: stringArray(params.reminder.emailRecipients),
    channels: stringArray(params.reminder.channels),
    accountIds: [] as string[],
    ...(timeArray(params.reminder.reminderTimes).length > 0
      ? { reminderTimes: timeArray(params.reminder.reminderTimes) }
      : {}),
  };
  const recurring = params.recurring && typeof params.recurring.frequency === 'string'
    ? {
        enabled: true,
        frequency: params.recurring.frequency,
        interval: Number(params.recurring.interval) >= 1 ? Number(params.recurring.interval) : 1,
        endType: typeof params.recurring.endType === 'string' ? params.recurring.endType : 'never',
        ...(params.recurring.endCount !== undefined ? { endCount: params.recurring.endCount } : {}),
        ...(params.recurring.endDate !== undefined ? { endDate: params.recurring.endDate } : {}),
      }
    : null;

  return client
    .query(
      `INSERT INTO events (
         user_id, profile_id, name, type, date, calendar_type, reminder_config,
         notification_channels, notification_account_ids, recurring_config, next_occurrence
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [
        userId,
        profileId,
        params.name,
        params.type,
        params.date,
        params.calendarType,
        JSON.stringify(reminderConfig),
        JSON.stringify(reminderConfig.channels),
        JSON.stringify([]),
        recurring ? JSON.stringify(recurring) : null,
        recurring ? params.date : null,
      ],
    )
    .then((result) => Number((result.rows[0] as RawRow).id));
}

async function ownsRow(
  client: PoolClient,
  table: 'habits' | 'maintenance_plans',
  userId: number,
  id: number,
): Promise<boolean> {
  const result = await client.query(`SELECT id FROM ${table} WHERE id = $1 AND user_id = $2`, [id, userId]);
  return result.rows.length > 0;
}

async function instantiateStep(
  client: PoolClient,
  userId: number,
  step: RoutineTemplateStep,
  anchorDate: string,
  fallbackProfileId: number | null,
): Promise<InstantiateReportItem> {
  const payload = step.payload;
  const profileId = toPositiveIntOrNull(payload.profileId) ?? fallbackProfileId;
  const title = step.title.trim() || '未命名步骤';
  const reminder = parseJsonObject(payload.reminder);

  switch (step.kind) {
    case 'event':
    case 'todo': {
      const isTodo = step.kind === 'todo';
      const eventId = await insertEventItem(client, userId, profileId, {
        name: title,
        type: isTodo ? 'other' : String(payload.eventType ?? 'other'),
        date: itemDate(anchorDate, step, payload),
        calendarType: payload.calendarType === 'lunar' ? 'lunar' : 'gregorian',
        leadDays: numberArray(reminder.daysBeforeList).length > 0
          ? numberArray(reminder.daysBeforeList)
          : isTodo
            ? DEFAULT_TODO_LEAD_DAYS
            : DEFAULT_LEAD_DAYS,
        reminder,
        recurring: isTodo ? null : parseJsonObject(payload.recurring),
      });
      return { stepId: step.id, kind: step.kind, title, status: 'created', entityType: 'event', entityId: eventId };
    }

    case 'habit': {
      const habitId = toPositiveIntOrNull(payload.habitId);
      if (habitId !== null) {
        if (!(await ownsRow(client, 'habits', userId, habitId))) {
          throw new TemplateStepError(`习惯 ${habitId} 不存在或不属于当前用户`, step.id, step.kind);
        }
        return { stepId: step.id, kind: step.kind, title, status: 'linked', entityType: 'habit', entityId: habitId };
      }
      const spec = parseJsonObject(payload.habit);
      const inserted = await client.query(
        `INSERT INTO habits (user_id, profile_id, name, icon, target_per_period, period, schedule_days, reminder_times, color, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE) RETURNING id`,
        [
          userId,
          profileId,
          title,
          spec.icon == null ? null : String(spec.icon),
          Number(spec.targetPerPeriod) >= 1 ? Math.trunc(Number(spec.targetPerPeriod)) : 1,
          spec.period === 'week' ? 'week' : 'day',
          numberArray(spec.scheduleDays).length > 0 ? numberArray(spec.scheduleDays) : null,
          timeArray(spec.reminderTimes).length > 0 ? timeArray(spec.reminderTimes) : null,
          spec.color == null ? null : String(spec.color),
        ],
      );
      return {
        stepId: step.id,
        kind: step.kind,
        title,
        status: 'created',
        entityType: 'habit',
        entityId: Number((inserted.rows[0] as RawRow).id),
      };
    }

    case 'maintenance': {
      const planId = toPositiveIntOrNull(payload.maintenancePlanId);
      if (planId !== null) {
        if (!(await ownsRow(client, 'maintenance_plans', userId, planId))) {
          throw new TemplateStepError(`保养计划 ${planId} 不存在或不属于当前用户`, step.id, step.kind);
        }
        return {
          stepId: step.id,
          kind: step.kind,
          title,
          status: 'linked',
          entityType: 'maintenance',
          entityId: planId,
        };
      }
      const spec = parseJsonObject(payload.maintenance);
      const intervalDays = Number.isSafeInteger(Number(spec.intervalDays)) && Number(spec.intervalDays) > 0
        ? Math.trunc(Number(spec.intervalDays))
        : null;
      const nextDueAt = intervalDays === null ? null : shiftCalendarDays(anchorDate, intervalDays);
      const inserted = await client.query(
        `INSERT INTO maintenance_plans (
           user_id, profile_id, asset_name, asset_kind, interval_days, interval_usage, usage_unit,
           current_usage, last_done_at, next_due_at, next_due_usage, notes, reminder_config, is_active
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, NULL, $10, $11, TRUE) RETURNING id`,
        [
          userId,
          profileId,
          title,
          typeof spec.assetKind === 'string' && spec.assetKind.trim() ? spec.assetKind.trim() : 'other',
          intervalDays,
          spec.intervalUsage == null ? null : Number(spec.intervalUsage),
          spec.usageUnit == null ? null : String(spec.usageUnit),
          null,
          nextDueAt,
          spec.notes == null ? null : String(spec.notes),
          JSON.stringify(reminder),
        ],
      );
      return {
        stepId: step.id,
        kind: step.kind,
        title,
        status: 'created',
        entityType: 'maintenance',
        entityId: Number((inserted.rows[0] as RawRow).id),
      };
    }
  }
}

/**
 * 实例化整套 routine。
 *
 * - 同一 (user, template, slot) 只允许一次：唯一键 + ON CONFLICT DO NOTHING 挡住双击/重试；
 * - 整套条目与实例占位在同一个事务中创建，失败全量回滚（重试仍然幂等）；
 * - 返回逐条创建报告（步骤 → 实体 id）。
 */
export async function instantiateTemplate(
  userId: number,
  templateId: number,
  options: InstantiateOptions = {},
): Promise<TemplateInstantiateResult> {
  const template = await getTemplate(userId, templateId);
  if (!template) return { status: 'not_found' };

  const timeZone = await getUserTimezone(userId);
  const anchorDate = (options.anchorDate?.trim() || dateStringInTimeZone(new Date(), timeZone)).slice(0, 10);
  if (shiftCalendarDays(anchorDate, 0) === null) return { status: 'invalid_anchor' };

  const slotKey = (options.slot?.trim() || anchorDate).slice(0, MAX_SLOT_LENGTH);
  const fallbackProfileId = toPositiveIntOrNull(options.profileId);

  return withTransaction(async (client) => {
    const claim = await client.query(
      `INSERT INTO routine_template_instances (user_id, template_id, slot_key, anchor_date)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, template_id, slot_key) DO NOTHING
       RETURNING id`,
      [userId, templateId, slotKey, anchorDate],
    );
    const claimed = claim.rows[0] as RawRow | undefined;
    if (!claimed) {
      // 该 slot 已实例化过：不重复创建任何条目。
      const existing = await client.query(
        `SELECT id, created_at FROM routine_template_instances
          WHERE user_id = $1 AND template_id = $2 AND slot_key = $3`,
        [userId, templateId, slotKey],
      );
      const row = existing.rows[0] as RawRow | undefined;
      return {
        status: 'already_instantiated' as const,
        instanceId: row ? Number(row.id) : 0,
        slotKey,
        anchorDate,
        createdAt: toIsoOrNull(row?.created_at),
      };
    }

    const instanceId = Number(claimed.id);
    const report: InstantiateReportItem[] = [];
    for (const step of template.steps) {
      report.push(await instantiateStep(client, userId, step, anchorDate, fallbackProfileId));
    }
    await client.query('UPDATE routine_template_instances SET report = $2 WHERE id = $1', [
      instanceId,
      JSON.stringify(report),
    ]);
    return { status: 'ok' as const, instanceId, slotKey, anchorDate, report };
  });
}
