/** Task 137: wire shapes returned by /api/data-health. */

export type DataHealthKind =
  | 'orphan_tag_links'
  | 'events_no_profile'
  | 'contacts_no_cadence'
  | 'expired_not_archived'
  | 'duplicate_contacts'
  | 'unset_timezone';

export interface DataHealthRepairInfo {
  label: string;
  destructive: boolean;
  hint: string;
}

export interface DataHealthFinding {
  kind: DataHealthKind;
  title: string;
  description: string;
  severity: 'info' | 'warning';
  count: number;
  examples: Array<Record<string, unknown>>;
  repair: DataHealthRepairInfo;
}

export interface DataHealthReport {
  generatedAt: string;
  totalFindings: number;
  totalIssues: number;
  findings: DataHealthFinding[];
}

export interface DataHealthRepairResult {
  kind: DataHealthKind;
  repaired: number;
  destructive: boolean;
  confirmed: boolean;
  message: string;
}
