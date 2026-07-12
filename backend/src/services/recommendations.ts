/** Smart recommended reminder days by event type (no AI / no API key). */
const RECOMMENDATIONS: Record<string, number[]> = {
  birthday: [0, 1, 3, 7],
  anniversary: [0, 1, 7, 14],
  exam: [0, 1, 3, 7, 14],
  holiday: [0, 1, 3],
  meeting: [0, 1],
  deadline: [0, 1, 3, 7],
  travel: [0, 1, 3],
  graduation: [0, 1, 7],
  wedding: [0, 1, 7, 14],
  medical: [0, 1],
  custom: [0, 1, 3],
};

export function getRecommendedDaysBefore(eventType: string): number[] {
  return RECOMMENDATIONS[eventType] ?? [0, 1, 3, 7];
}
