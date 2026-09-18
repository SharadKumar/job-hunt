/**
 * tools/ui/labels.ts - the words the UI uses for a channel, a status, a lane
 * and a length of time, on the server side.
 *
 * This is the mirror of the four helpers exported from tools/ui/static/app.js
 * and it must give the same answer for the same input. They are two files
 * because one runs in a browser with no build step and the other runs in node;
 * they are not two vocabularies. When one changes, change the other in the
 * same session, or the API and the page start describing the same row with
 * two different words.
 *
 * The rule behind the tables (docs/ui-redesign-2026-09-18.md, section 3,
 * principle 5): the machine's own vocabulary is shown once, as a pill, and the
 * person's vocabulary everywhere else. `statusLabel` is the person's half.
 */

/** Channel ids are module names; say them the way the site is named. */
const CHANNEL_LABELS: Record<string, string> = {
  seek: "SEEK",
  linkedin: "LinkedIn",
  linkedin_jobs: "LinkedIn",
  linkedin_posts: "LinkedIn posts",
  hn: "Hacker News",
};

/** A channel key as the person says it out loud. */
export function channelLabel(channel: string | null | undefined): string {
  const key = String(channel ?? "").toLowerCase();
  if (CHANNEL_LABELS[key]) return CHANNEL_LABELS[key];
  return key
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** The pipeline status in the person's vocabulary, not the machine's. */
const STATUS_LABELS: Record<string, string> = {
  discovered: "Discovered",
  shortlisted: "In queue",
  drafted: "In queue",
  awaiting_approval: "In queue",
  approved: "In queue",
  submission_pending: "Being sent",
  submitted: "Sent",
  responded: "Replied",
  interview: "Interview",
  offered: "Offer",
  won: "Won",
  rejected: "Rejected",
  withdrawn: "Withdrawn",
  parked: "Parked",
  awaiting_external: "Waiting on them",
  manual_action_needed: "Needs you",
};

/** A status the table has not met yet still reads as words, not as a key. */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return "";
  return STATUS_LABELS[status] ?? String(status).replace(/_/g, " ");
}

/**
 * The lane, as the person names it. AGENTS.md section 2: the channel decides
 * the lane, and "You" is the lane where nothing leaves this machine without
 * the person present.
 */
const LANE_LABELS: Record<string, string> = { autopilot: "Autopilot", attended: "You" };

export function laneLabel(lane: string | null | undefined): string {
  return LANE_LABELS[String(lane ?? "").toLowerCase()] ?? "";
}

/**
 * How long something took, in one format everywhere: "48 s", "4 m 12 s",
 * "1 h 46 m". Anything that is not a count of seconds says nothing at all
 * rather than guessing.
 */
export function duration(seconds: number | null | undefined): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(Math.round(seconds % 60)).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}
