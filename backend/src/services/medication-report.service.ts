import type { AdherenceReport, MedicationRecord, RefillItem } from '@timemark/shared';
import {
  getAdherence,
  getAdherenceDaily,
  getRefills,
  listMedications,
  type AdherenceDailyPoint,
} from './medication.service.js';
import { getProfile } from './profile.service.js';

/**
 * 医生可读的用药依从性报告（checkbox 74）—— 数据装配层。
 *
 * 复用 checkbox 72 的依从性数学（`getAdherence`：百分比 / 连胜 / per-medication）与
 * 补货判定（`getRefills`），本层只做「取数 + 组装」，绝不重新实现统计口径：
 * - 百分比、total、连胜一律来自 `AdherenceReport`；
 * - 每日明细来自 `getAdherenceDaily`（同一时区 / 窗口 / profile 谓词）；
 * - 药品清单来自 `listMedications`（含 dosage / 状态）；补货来自 `getRefills`。
 *
 * 报告是纯记录：不含任何 AI 推断、医疗建议或用药解读。
 */

/** `?profileId=` 省略时的档案名（与既有 API「省略 = 全部档案」的语义一致）。 */
export const ALL_PROFILES_LABEL = '全部档案';

export interface MedicationReportView {
  profileId: number | null;
  profileName: string;
  from: string;
  to: string;
  adherence: AdherenceReport;
  daily: AdherenceDailyPoint[];
  medications: MedicationRecord[];
  refills: RefillItem[];
}

/**
 * 取齐一份报告所需的全部数据。`profileId` 的归属校验由路由的 `parseProfileFilter`
 * 负责（他人的档案根本不会到达这里）；本层仅按 `user_id` 限定读取。
 */
export async function buildMedicationReport(
  userId: number,
  from: string,
  to: string,
  opts: { profileId: number | null },
): Promise<MedicationReportView> {
  const profileId = opts.profileId;
  const [adherence, daily, medications, refills, profileName] = await Promise.all([
    getAdherence(userId, from, to, { profileId }),
    getAdherenceDaily(userId, from, to, { profileId }),
    listMedications(userId, { profileId }),
    getRefills(userId, { profileId }),
    profileId == null ? Promise.resolve(ALL_PROFILES_LABEL) : resolveProfileName(userId, profileId),
  ]);

  return { profileId, profileName, from, to, adherence, daily, medications, refills };
}

async function resolveProfileName(userId: number, profileId: number): Promise<string> {
  const profile = await getProfile(userId, profileId);
  const name = profile?.name?.trim();
  return name ? name : `档案 #${profileId}`;
}
