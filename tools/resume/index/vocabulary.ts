/**
 * resume-index vocabulary: the words the binder page speaks in.
 *
 * Pure functions over a built `ResumeCard`: dates in long form, gate names in
 * plain English, the readiness sentences and the single next move. No file
 * access and no HTML, so the wording can be read and tested on its own.
 */

import type { ResumeCard } from "./model.ts";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Small counts read better as words in a sentence; large ones as digits. */
export function countWord(n: number): string {
  const spelled = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
    "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
  return n >= 0 && n < spelled.length ? spelled[n] : String(n);
}

export const words = countWord;

export function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** "2026-01-03" -> "3 January", plus the year when it isn't the current one. */
export function longDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const stamp = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  return d.getUTCFullYear() === new Date().getUTCFullYear() ? stamp : `${stamp} ${d.getUTCFullYear()}`;
}

/** Compact form for the rail, e.g. "10 Sep". */
export function shortHumanDate(iso: string | null): string | null {
  const long = longDate(iso);
  return long ? long.replace(/([A-Z][a-z]{2})[a-z]+/, "$1") : null;
}

const GATE_LABELS: Record<string, string> = { ats: "ATS" };

export function gateLabel(name: string): string {
  return GATE_LABELS[name] ?? upperFirst(name.replace(/[_-]+/g, " "));
}

export function verdictWords(verdict: string): string {
  if (verdict === "pass") return "passes";
  if (verdict === "warn") return "worth a look";
  if (verdict === "fail") return "fails";
  return "not run";
}

export function pageCountOf(card: ResumeCard): number {
  return card.audit?.page_count ?? card.pngs.length;
}

/**
 * The readiness paragraph. The stamp above it already says the approval state
 * and the tick row below already says which checks pass, so this says only two
 * things: the shape of the paper, and the single most useful next move.
 */
export function readinessSentences(card: ResumeCard): string[] {
  if (card.status === "missing") return ["No render on disk yet.", `Run /resume-render ${card.id} to make one.`];

  const out: string[] = [];
  const fills = card.audit?.fills ?? [];
  const pages = pageCountOf(card);
  if (pages > 0) {
    const noun = pages === 1 ? "page" : "pages";
    if (fills.length > 1) {
      const low = Math.round(Math.min(...fills));
      const high = Math.round(Math.max(...fills));
      out.push(low === high
        ? `${upperFirst(words(pages))} ${noun}, each filled to ${low} percent.`
        : `${upperFirst(words(pages))} ${noun}, filled between ${low} and ${high} percent.`);
    } else if (fills.length === 1) {
      out.push(`${upperFirst(words(pages))} ${noun}, filled to ${Math.round(fills[0])} percent.`);
    } else {
      out.push(`${upperFirst(words(pages))} ${noun} on the desk.`);
    }
  }
  out.push(nextMove(card));
  return out;
}

/** One sentence: the most important thing left to do, and nothing else. */
export function nextMove(card: ResumeCard): string {
  const failing = card.checks.filter((c) => c.verdict === "fail");
  if (failing.length) {
    return `Next, fix ${joinList(failing.map((c) => c.label.toLowerCase()))}.`;
  }
  const units = card.audit?.failing_units ?? 0;
  if (units > 0) {
    return `Next, shorten ${words(units)} ${units === 1 ? "block that runs" : "blocks that run"} longer than the template prefers.`;
  }
  const questions = card.openQuestions.length;
  if (questions > 0) {
    return `Next, answer ${words(questions)} open ${questions === 1 ? "question" : "questions"} on the keyword plan.`;
  }
  const thin = card.pages.map((page, i) => ({ page, number: i + 1 })).filter((x) => x.page.low);
  if (thin.length) {
    const labels = thin.map((x) => String(x.number));
    return `Next, fill ${labels.length === 1 ? "page" : "pages"} ${joinList(labels)} closer to the floor.`;
  }
  if (card.status === "stale") {
    const worst = card.checks.find((c) => c.verdict === "warn");
    if (worst) {
      // Only the first fragment: a whole compound reason overloads the sentence.
      const head = worst.reason ? worst.reason.split("; ")[0] : "";
      const what = head ? `${worst.label.toLowerCase()}'s ${head}` : worst.label.toLowerCase();
      return `Next, re-approve it now the pages have been rebuilt, after a look at ${what}.`;
    }
    return "Next, re-approve it now the pages have been rebuilt.";
  }
  if (card.status === "fresh") return "Next, approve it so it can go out.";
  const warns = card.checks.filter((c) => c.verdict === "warn");
  if (warns.length) return `Next, glance at ${joinList(warns.map((c) => c.label.toLowerCase()))} when you have a moment.`;
  return "Nothing is outstanding.";
}

/** The one-line state under a positioning name in the rail. */
export function railState(card: ResumeCard): string {
  if (card.failCount > 0) return `Needs a look: ${words(card.failCount)} ${card.failCount === 1 ? "check failing" : "checks failing"}`;
  if (card.status === "approved") {
    const when = shortHumanDate(card.statusDate);
    return when ? `Ready to send, approved ${when}` : "Ready to send";
  }
  if (card.openQuestions.length) {
    const n = card.openQuestions.length;
    return `Needs a look: ${n} open ${n === 1 ? "question" : "questions"}`;
  }
  if (card.status === "stale") return "Approved once, rebuilt since";
  if (card.status === "fresh") return "Rendered, not yet approved";
  return "No render yet";
}

/* ------------------------------------------------------------- vocabulary */

/** The state colour a tab, stamp or dot is inked in. */
export function stateClass(card: ResumeCard): string {
  const base = `state-${card.stamp.kind}`;
  return card.active ? base : `${base} is-inactive`;
}
