import type { HolidayMarker } from '@/lib/chinese-holidays';

/**
 * 休/班 day marker for the calendar (plan todo 76d).
 *
 * Holiday names come from the vendored dataset, but they are rendered as text
 * nodes (never dangerouslySetInnerHTML) — an HTML-bearing name is displayed
 * literally instead of being interpreted.
 */
export function HolidayBadge({ marker, className = '' }: { marker: HolidayMarker; className?: string }) {
  const palette =
    marker.kind === 'holiday'
      ? 'bg-red-100 text-red-600 dark:bg-red-900/40 dark:text-red-300'
      : 'bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300';
  return (
    <span className={`inline-flex items-center gap-0.5 ${className}`}>
      <span className={`rounded px-0.5 text-[9px] font-bold leading-4 ${palette}`}>{marker.label}</span>
      {marker.name && (
        <span className="truncate text-[9px] leading-4 text-red-500 dark:text-red-300" data-testid="holiday-name">
          {marker.name}
        </span>
      )}
    </span>
  );
}
