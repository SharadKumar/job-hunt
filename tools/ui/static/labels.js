/*
 * labels.js - the words and the formats the whole front end shares: how a
 * channel, a status, a lane, a date and a length of time are said out loud.
 *
 * Every one of these is exported again from app.js, which is where the screens
 * import them from. They live here because app.js is the router and the DOM
 * helpers, and a vocabulary is neither.
 *
 * tools/ui/labels.ts is the server's copy of the first four tables and must
 * give the same answer for the same input. Two files, one vocabulary: when one
 * changes, change the other in the same session.
 *
 * AGENTS.md section 3: Australian English, and no em or en dashes anywhere.
 */

/**
 * The machine's status in the person's own vocabulary (the redesign brief,
 * section 3, principle 5). The raw keys are machinery: nobody reads
 * "manual_action_needed to manual_action_needed" and learns anything. The
 * machine's word is shown once, as a pill; these are what is said everywhere
 * else.
 */
const STATUS_LABELS = {
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

/** A status the map has not met yet still reads as words, not as a key. */
export function statusLabel(status) {
  if (!status) return "";
  return STATUS_LABELS[status] || String(status).replace(/_/g, " ");
}

/**
 * The lane, as the person names it. AGENTS.md section 2: the channel decides
 * the lane, and "You" is the lane where nothing leaves this machine without
 * the person present.
 */
const LANE_LABELS = { autopilot: "Autopilot", attended: "You" };

export function laneLabel(lane) {
  const key = String(lane || "").toLowerCase();
  return LANE_LABELS[key] || "";
}

/** Channel ids are module names; say them the way the site is named. */
const CHANNEL_LABELS = {
  seek: "SEEK",
  linkedin: "LinkedIn",
  linkedin_jobs: "LinkedIn",
  linkedin_posts: "LinkedIn posts",
  hn: "Hacker News",
};

/** A channel key as the person says it out loud. One definition for the whole
 * front end; tools/ui/labels.ts is the server's copy of the same table. */
export function channelLabel(channel) {
  const key = String(channel || "").toLowerCase();
  if (CHANNEL_LABELS[key]) return CHANNEL_LABELS[key];
  return key.split(/[_\s-]+/).filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * How long something took, in one format everywhere: "48 s", "4 m 12 s",
 * "1 h 46 m". Anything that is not a count of seconds says nothing at all
 * rather than guessing.
 */
export function duration(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} m ${String(Math.round(seconds % 60)).padStart(2, "0")} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
}

/**
 * Three letter months. en-AU's own short month is "Sept", four letters and out
 * of step with the other eleven, so the UI carries its own table and every date
 * on every screen reads the same way: "17 Sep".
 */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const asDate = (value) => (value instanceof Date ? value : new Date(value));

/** "17 Sep", or "" when there is no date to say. */
export function shortDate(value) {
  const d = asDate(value);
  return !value || Number.isNaN(d.getTime()) ? "" : `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** The clock on its own, 24 hour: "08:12". */
export const clockTime = (value) => (!value || Number.isNaN(asDate(value).getTime()) ? ""
  : asDate(value).toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }));

/** "Thu 17 Sep", and with the clock when it is asked for. */
export function dayStamp(value, withTime) {
  const day = shortDate(value);
  if (!day) return "";
  const full = `${asDate(value).toLocaleDateString("en-AU", { weekday: "short" })} ${day}`;
  return withTime ? `${full}, ${clockTime(value)}` : full;
}

/**
 * The one time format in the UI (the brief, section 6, Global components).
 * Four formats were in use and the same instant read four ways on one screen:
 *
 *   today            08:19
 *   this week        Tue 08:19
 *   this year        17 Sep
 *   before that      17 Sep 2025
 *
 * The full timestamp belongs in a title attribute; `whenFull` writes it. A
 * value that is not a date comes back as it arrived rather than as "Invalid
 * Date": the caller knows what it was given and the person should see it.
 */
export function when(iso, now) {
  if (!iso) return "";
  const d = asDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const at = now ? asDate(now) : new Date();
  const day = (value) => `${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
  if (day(d) === day(at)) return clockTime(d);
  // Within a week either side the weekday and clock say enough; a next run on
  // Monday reads "Mon 07:00", not a bare date.
  const daysAway = Math.abs(Math.floor((at.getTime() - d.getTime()) / 86400000));
  if (daysAway < 7) {
    return `${d.toLocaleDateString("en-AU", { weekday: "short" })} ${clockTime(d)}`;
  }
  const short = shortDate(d);
  return d.getFullYear() === at.getFullYear() ? short : `${short} ${d.getFullYear()}`;
}

/** The whole instant, for the title attribute beside a `when()`. */
export function whenFull(iso) {
  if (!iso) return "";
  const d = asDate(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.toLocaleDateString("en-AU", { weekday: "short" })} ${shortDate(d)} ${d.getFullYear()}, ${clockTime(d)}`;
}

/** The person's own day as YYYY-MM-DD, so "sent today" means what they mean. */
export const localDay = (value) => {
  const d = value ? new Date(value) : new Date();
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("en-CA").format(d); // ISO day, browser timezone
};

/** Apply method in plain words, the way the person would say it out loud. */
export const APPLY_METHODS = {
  quick_apply: "quick apply",
  easy_apply: "easy apply",
  external: "external",
};

