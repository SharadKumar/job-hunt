import type { ExperienceItem } from "./_interface.ts";

function dateRank(value: string): number {
  if (!value || value === "current") return Number.MAX_SAFE_INTEGER;
  const match = value.match(/^(\d{4})-(\d{2})$/);
  return match ? Number(match[1]) * 12 + Number(match[2]) : 0;
}

/** Ongoing engagements head the list; everything else is ranked by when it began. */
function ongoingRank(value: string): number {
  return !value || value === "current" ? 1 : 0;
}

/**
 * Stable reverse-chronological ordering across featured and compact entries.
 *
 * The printed date column is read left to right, so the start date is what a
 * reader tracks down the page: two overlapping engagements must print in the
 * order they began, or the column steps backwards and then forwards again.
 * Ongoing roles still sort to the top regardless of when they started, and the
 * end date only breaks a tie between two entries that began the same month.
 */
export function orderedExperiences(experiences: ExperienceItem[]): Array<{ xp: ExperienceItem; index: number }> {
  return experiences
    .map((xp, index) => ({ xp, index }))
    .sort((a, b) => compareExperienceOrder(a.xp, b.xp) || a.index - b.index);
}

/**
 * The single comparator behind both the rendered order and the chronology gate,
 * so a composition can never validate in an order no template will print.
 * Negative means `a` belongs above `b`.
 */
export function compareExperienceOrder(a: Pick<ExperienceItem, "start" | "end">, b: Pick<ExperienceItem, "start" | "end">): number {
  return ongoingRank(b.end) - ongoingRank(a.end)
    || dateRank(b.start) - dateRank(a.start)
    || dateRank(b.end) - dateRank(a.end);
}
