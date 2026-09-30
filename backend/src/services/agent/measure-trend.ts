/**
 * Shared "simple trend" over numeric measurements (tasks 154 + 155).
 *
 * Pure: takes timestamped points and returns the summary both the care vitals
 * history and the pet weight history display. No DB access.
 */

export interface MeasurePoint {
  /** ISO timestamp. */
  at: string;
  value: number;
  unit?: string | null;
}

export type MeasureDirection = 'rising' | 'falling' | 'stable' | 'none';

export interface MeasureTrend {
  points: MeasurePoint[];
  count: number;
  first: MeasurePoint | null;
  latest: MeasurePoint | null;
  /** latest.value - first.value (null when there are no points). */
  delta: number | null;
  min: number | null;
  max: number | null;
  average: number | null;
  direction: MeasureDirection;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeMeasureTrend(points: readonly MeasurePoint[]): MeasureTrend {
  const ordered = [...points]
    .filter((point) => Number.isFinite(point.value) && Number.isFinite(Date.parse(point.at)))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

  if (ordered.length === 0) {
    return {
      points: [],
      count: 0,
      first: null,
      latest: null,
      delta: null,
      min: null,
      max: null,
      average: null,
      direction: 'none',
    };
  }

  const values = ordered.map((point) => point.value);
  const first = ordered[0];
  const latest = ordered[ordered.length - 1];
  const delta = round2(latest.value - first.value);

  return {
    points: ordered,
    count: ordered.length,
    first,
    latest,
    delta,
    min: Math.min(...values),
    max: Math.max(...values),
    average: round2(values.reduce((sum, value) => sum + value, 0) / values.length),
    direction: delta > 0 ? 'rising' : delta < 0 ? 'falling' : 'stable',
  };
}
