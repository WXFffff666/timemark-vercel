/**
 * 一次投递的真实结果。
 *
 * event_trigger_logs.status 只有 success / failed / skipped 三种，而"部分失败"被记成
 * success：3 个渠道成功、1 个失败时 status='success'、error_message 却有内容。后果有两处：
 * 前端显示绿色"成功"并把错误藏起来；重试接口按 status==='success' 直接 400，用户补不了。
 *
 * 另外 sendNotifications 会在结果 map 里放内部标记键（_skipped / _quiet_hours），它们都是
 * success:false 但并不是渠道。旧代码把它们当失败渠道，于是安静时段投递会写下
 * error_message="_quiet_hours: quiet_hours"，error_details.channel_type 也是这个假渠道。
 *
 * 不新增 status 取值——去重、统计、清理、导出共 40 处查询按它工作，改取值要动一大片。
 * 改为从已经落库的 channel_results 推导，前端与后端共用这一份判定，免得又抄成两个。
 */

/** delivered=全部渠道成功；partial=有成功也有失败；failed=都没成功；skipped=根本没发 */
export type DeliveryOutcome = 'delivered' | 'partial' | 'failed' | 'skipped';

/** 内部标记键：不是渠道，不参与成功/失败统计 */
const MARKER_KEYS = new Set(['_skipped', '_quiet_hours']);

export interface DeliveryReport {
  outcome: DeliveryOutcome;
  /** 成功投递的渠道 id */
  delivered: string[];
  /** 未送达的渠道 id */
  failed: string[];
  /** 失败原因 / 跳过原因码，供界面直接展示 */
  reason?: string;
}

/** channel_results 可能是对象（JSONB）或 JSON 字符串（历史 TEXT 列），也可能已经坏了 */
function parseChannelResults(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function errorOf(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const error = (entry as { error?: unknown }).error;
  return typeof error === 'string' && error ? error : undefined;
}

/**
 * 真实渠道 id（剔除内部标记键），保持 channel_results 里的原始顺序。
 * 界面列"渠道"时用这个：把 _quiet_hours 当渠道显示出来会让人以为存在一个叫
 * _quiet_hours 的通知渠道。
 */
export function realChannelIds(channelResults: unknown): string[] {
  return Object.keys(parseChannelResults(channelResults)).filter((k) => !MARKER_KEYS.has(k));
}

/**
 * 从落库的一行推导真实投递结果。`channel_results` 缺失或已损坏时回退到 status，
 * 因此历史行（没有 channel_results 的老数据）仍然能得到可显示的状态。
 */
export function readDelivery(input: {
  status?: string | null;
  channelResults?: unknown;
  errorMessage?: string | null;
}): DeliveryReport {
  const entries = parseChannelResults(input.channelResults);
  const channelKeys = realChannelIds(input.channelResults);
  const hasMarker = Object.keys(entries).some((k) => MARKER_KEYS.has(k));

  const delivered = channelKeys.filter((k) => {
    const entry = entries[k];
    return !!entry && typeof entry === 'object' && (entry as { success?: unknown }).success === true;
  });
  const failedKeys = channelKeys.filter((k) => !delivered.includes(k));
  const reason = failedKeys
    .map((k) => {
      const error = errorOf(entries[k]);
      return error ? `${k}: ${error}` : k;
    })
    .join('; ');

  const status = input.status ?? '';

  if (status === 'skipped') {
    return { outcome: 'skipped', delivered, failed: failedKeys, reason: input.errorMessage ?? reason ?? undefined };
  }
  if (delivered.length > 0 && failedKeys.length > 0) {
    return { outcome: 'partial', delivered, failed: failedKeys, reason: reason || undefined };
  }
  if (delivered.length > 0) {
    return { outcome: 'delivered', delivered, failed: [], reason: undefined };
  }
  if (failedKeys.length > 0) {
    return { outcome: 'failed', delivered: [], failed: failedKeys, reason: reason || undefined };
  }
  // 没有任何真实渠道：只有标记键说明是被安静时段/不支持渠道挡掉的，不是投递失败
  if (hasMarker) {
    return {
      outcome: 'skipped',
      delivered: [],
      failed: [],
      reason: input.errorMessage ?? markerReason(entries) ?? undefined,
    };
  }
  // 没有 channel_results 的历史行：只能信 status
  return status === 'success'
    ? { outcome: 'delivered', delivered: [], failed: [], reason: undefined }
    : { outcome: 'failed', delivered: [], failed: [], reason: input.errorMessage ?? undefined };
}

function markerReason(entries: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(entries).filter((k) => MARKER_KEYS.has(k))) {
    const error = errorOf(entries[key]);
    if (error) return error;
  }
  return undefined;
}