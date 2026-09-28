/**
 * `callback_data` codec for the Telegram inline keyboard (checkbox 93).
 *
 * Telegram caps `callback_data` at 64 bytes (UTF-8), so the wire format carries ONLY a
 * machine action plus numeric ids - never user-supplied text:
 *
 *   `{action}:{entity}:{id}`             e.g. `done:todo:42`, `open:todo:42`
 *   `{action}:{entity}:{id}:{minutes}`   e.g. `snooze:todo:42:10`
 *
 * `encodeCallbackData` asserts the 64-byte limit hard (a future action/entity rename must not
 * silently overflow it); `decodeCallbackData` is the tolerant other side - every malformed or
 * unknown payload returns `null` instead of throwing, so the webhook can always answer a
 * friendly toast.
 */

/** Telegram Bot API hard limit for `callback_data`, in UTF-8 bytes. */
export const CALLBACK_DATA_MAX_BYTES = 64;

/** Snooze bounds: 1 minute .. 7 days. Anything else is malformed input. */
export const CALLBACK_SNOOZE_MIN_MINUTES = 1;
export const CALLBACK_SNOOZE_MAX_MINUTES = 7 * 24 * 60;

export type CallbackAction = 'done' | 'snooze' | 'open';

export type CallbackEntity = 'todo';

export interface CallbackData {
  action: CallbackAction;
  entity: CallbackEntity;
  /** Entity id (the `events.id` for `entity: 'todo'`). */
  id: number;
  /** Present only for `action: 'snooze'`; minutes to extend the reminder by. */
  minutes?: number;
}

const ACTIONS: readonly CallbackAction[] = ['done', 'snooze', 'open'];
const ENTITIES: readonly CallbackEntity[] = ['todo'];

export function isCallbackDataWithinLimit(data: string): boolean {
  return Buffer.byteLength(data, 'utf8') <= CALLBACK_DATA_MAX_BYTES;
}

/**
 * Encode an inline-button payload. Throws (hard assertion) for an unknown action/entity, a
 * non-positive id, an out-of-range snooze duration, or a payload that would exceed 64 bytes.
 */
export function encodeCallbackData(input: CallbackData): string {
  if (!ACTIONS.includes(input.action)) {
    throw new Error(`Unknown callback action: ${String(input.action)}`);
  }
  if (!ENTITIES.includes(input.entity)) {
    throw new Error(`Unknown callback entity: ${String(input.entity)}`);
  }
  if (!Number.isSafeInteger(input.id) || input.id <= 0) {
    throw new Error(`Callback id must be a positive integer: ${String(input.id)}`);
  }

  let data: string;
  if (input.action === 'snooze') {
    const minutes = input.minutes;
    if (
      minutes === undefined
      || !Number.isInteger(minutes)
      || minutes < CALLBACK_SNOOZE_MIN_MINUTES
      || minutes > CALLBACK_SNOOZE_MAX_MINUTES
    ) {
      throw new Error(`Snooze minutes out of range: ${String(minutes)}`);
    }
    data = `${input.action}:${input.entity}:${input.id}:${minutes}`;
  } else {
    data = `${input.action}:${input.entity}:${input.id}`;
  }

  if (!isCallbackDataWithinLimit(data)) {
    throw new Error(`callback_data exceeds ${CALLBACK_DATA_MAX_BYTES} bytes: ${data}`);
  }
  return data;
}

/** Tolerant decode: `null` for anything malformed, unknown, oversized or out of range. */
export function decodeCallbackData(raw: unknown): CallbackData | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!isCallbackDataWithinLimit(raw)) return null;

  const parts = raw.split(':');
  if (parts.length !== 3 && parts.length !== 4) return null;

  const [actionRaw, entityRaw, idRaw, minutesRaw] = parts;
  if (!ACTIONS.includes(actionRaw as CallbackAction)) return null;
  if (!ENTITIES.includes(entityRaw as CallbackEntity)) return null;
  if (!/^\d{1,16}$/.test(idRaw)) return null;

  const id = Number(idRaw);
  if (!Number.isSafeInteger(id) || id <= 0) return null;

  const action = actionRaw as CallbackAction;
  const entity = entityRaw as CallbackEntity;

  if (action === 'snooze') {
    if (parts.length !== 4 || !/^\d{1,5}$/.test(minutesRaw)) return null;
    const minutes = Number(minutesRaw);
    if (minutes < CALLBACK_SNOOZE_MIN_MINUTES || minutes > CALLBACK_SNOOZE_MAX_MINUTES) return null;
    return { action, entity, id, minutes };
  }

  if (parts.length !== 3) return null;
  return { action, entity, id };
}

/** Human label for a snooze toast / edited message, e.g. `10 分钟`, `1 小时`. */
export function formatSnoozeLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}
