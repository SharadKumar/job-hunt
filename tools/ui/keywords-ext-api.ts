/**
 * Extension API module (keywords-ext). Registered by rows-ext-api.ts, which
 * offers every request here first; api.ts is not edited from this package.
 *
 * The keyword queue is the one screen that asks the person questions, so it is
 * the one screen where a wrong question costs attention. `GET /api/keywords/
 * pending` in api.ts is the raw ledger: a term, a count, the positionings that
 * asked. That is not enough to answer with. This module adds, per term, the
 * three things the person needs before they can answer in one glance:
 *
 *   - `recommendation`: what the deterministic triage would do with this term
 *     and why. `tools/resume/keyword-triage.ts` already decides `keep` or
 *     `reject` by a named rule, and the corpus already says whether the person
 *     has used the term. Running that here is a DRY RUN: nothing is recorded,
 *     nothing is answered, and the person's click is still the answer
 *     (AGENTS.md section 9). It only stops the UI asking "did you deliver
 *     Apply Now?" as if it were a real question.
 *   - `opportunities`: the adverts the term came from, by role and advertiser
 *     instead of by opportunity id. "Azure API Management, asked by the
 *     Integration Lead ad at Port Authority" is a question a person can answer;
 *     "asked by seek-4a1f09c2e117" is not.
 *   - `must_have`: whether any of those adverts' keyword plans marked the term
 *     as must-have, so the few terms that decide a screener sort to the top.
 *
 * `GET /api/keywords/triage` is the same dry run whole: the counts, the rules
 * that fired and both lists, for the Rules screen.
 *
 * The triage context reads the taxonomy, the clouds, cv-source.md and the
 * stoplist. On a fresh clone one of those is missing, and a listing must still
 * render: the failure then rides on every recommendation as a note naming the
 * file, rather than being swallowed or 500-ing the queue.
 */

import path from "node:path";
import { promises as fsp } from "node:fs";

import { getKeywordsPending, type ApiContext, type ApiRequest, type ApiResult } from "./api.ts";
import { get as getOpportunity } from "../pipeline.ts";
import { findPlanTerm, groupPending, readLedger, type PendingGroup } from "../resume/keyword-confirm.ts";
import { normalise, phraseInTextLoose, type KeywordPlan } from "../resume/keyword-lexicon.ts";
import {
  buildReport,
  loadTriageContext,
  pendingKeywordRows,
  triageRows,
  type TriageContext,
  type TriageReport,
  type TriageVerdict,
} from "../resume/keyword-triage.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { repoPath } from "../repo-root.ts";

/** What the UI shows beside the four answer buttons. Never an answer itself. */
export type Recommendation = {
  answer: "na" | "confirm" | "familiarity" | null;
  rule: string | null;
  note: string;
};

export type TermOpportunity = { id: string; title: string | null; company: string | null };

const key = (term: string): string => normalise(term).trim();

const archiveDirOf = (ctx: ApiContext): string => ctx.archiveDir ?? repoPath("state/pipeline/archive");

const ledgerPathOf = (ctx: ApiContext): string => resolveProfileContext(ctx.profileId ?? null).marketConfirmationsPath;

const cvSourcePathOf = (ctx: ApiContext): string => resolveProfileContext(ctx.profileId ?? null).cvSourcePath;

async function readTextIfExists(file: string): Promise<string | null> {
  try { return await fsp.readFile(file, "utf8"); } catch { return null; }
}

/**
 * The cv-source line a term already appears on, as `cv-source.md:12`. The keep
 * rule only says "it is in there somewhere"; a person deciding whether to
 * confirm wants to see which line, because that line is the evidence.
 */
export function cvSourceReference(term: string, cvSource: string | null): { line: number; text: string } | null {
  if (!cvSource) return null;
  const wanted = key(term);
  if (!wanted) return null;
  const lines = cvSource.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (phraseInTextLoose(wanted, normalise(text))) return { line: i + 1, text };
  }
  return null;
}

const clip = (text: string, width = 100): string => (text.length <= width ? text : `${text.slice(0, width - 1)}…`);

/**
 * One term's recommendation. A reject is a recommendation to answer "not
 * applicable", named by the rule that fired, because the rule is the argument.
 * A term the corpus already carries is a recommendation to confirm, with the
 * line as the evidence. Anything else is the semantic residue and gets no
 * recommendation at all: that one is a real question for the person.
 */
export function recommend(verdict: TriageVerdict | undefined, reference: { line: number; text: string } | null): Recommendation {
  if (verdict?.decision === "reject") {
    return { answer: "na", rule: verdict.rule, note: `${verdict.rule}: ${verdict.evidence}` };
  }
  if (reference) {
    return { answer: "confirm", rule: "in_cv_source", note: `already in cv-source.md:${reference.line}: "${clip(reference.text)}"` };
  }
  return { answer: null, rule: null, note: verdict ? `no rule decides this one: ${verdict.evidence}` : "not in the pending ledger" };
}

/** The dry run, and the context it needed, or the reason there is neither. */
type TriagePass = {
  report: TriageReport | null;
  verdicts: Map<string, TriageVerdict>;
  error: string | null;
};

async function triagePass(ctx: ApiContext): Promise<TriagePass> {
  const ledger = ledgerPathOf(ctx);
  let context: TriageContext;
  try {
    context = await loadTriageContext({ profile: ctx.profileId ?? null });
  } catch (error: any) {
    // A missing stoplist or taxonomy is a setup gap, not a reason to hide the
    // queue. Say which file, on every term, and recommend nothing.
    return { report: null, verdicts: new Map(), error: String(error?.message ?? error) };
  }
  const rows = pendingKeywordRows(await readLedger(ledger));
  const verdicts = triageRows(rows, context);
  const byTerm = new Map<string, TriageVerdict>();
  for (const verdict of verdicts) byTerm.set(key(verdict.term), verdict);
  return { report: buildReport(verdicts, { ledger, dryRun: true }), verdicts: byTerm, error: null };
}

/** The keyword plan an opportunity was drafted against, if it is still on disk. */
async function readPlanFor(id: string, ctx: ApiContext, cache: Map<string, KeywordPlan | null>): Promise<KeywordPlan | null> {
  if (cache.has(id)) return cache.get(id) ?? null;
  const text = await readTextIfExists(path.join(archiveDirOf(ctx), id, "keyword-plan.json"));
  let plan: KeywordPlan | null = null;
  if (text !== null) {
    try { plan = JSON.parse(text) as KeywordPlan; } catch { plan = null; }
  }
  cache.set(id, plan);
  return plan;
}

export type EnrichedTerm = Record<string, unknown> & {
  term: string;
  recommendation: Recommendation;
  opportunities: TermOpportunity[];
  must_have: boolean;
};

/**
 * GET /api/keywords/pending, wrapped. The page, the totals and the order are
 * api.ts's; everything added here is per term and read-only.
 */
export async function getKeywordsPendingPlus(
  query: { limit?: string | null; offset?: string | null; resume?: string | null; q?: string | null; all?: string | null } = {},
  ctx: ApiContext = {},
): Promise<Record<string, unknown>> {
  const base = await getKeywordsPending(query, ctx);
  const pass = await triagePass(ctx);
  const cvSource = pass.error ? null : await readTextIfExists(cvSourcePathOf(ctx));

  // The ledger again, grouped the same way, for the two things the summary
  // shape does not carry: which adverts asked, and under which plans.
  const groups = new Map<string, PendingGroup>();
  for (const group of groupPending(await readLedger(ledgerPathOf(ctx)), query.resume ?? null)) {
    groups.set(key(group.term), group);
  }

  const plans = new Map<string, KeywordPlan | null>();
  const rows = new Map<string, TermOpportunity>();
  const terms: EnrichedTerm[] = [];

  for (const item of base.terms as unknown as Record<string, unknown>[]) {
    const term = String(item.term ?? "");
    const group = groups.get(key(term));
    const ids = group?.opportunities ?? [];

    const opportunities: TermOpportunity[] = [];
    let mustHave = false;
    for (const id of ids) {
      if (!rows.has(id)) {
        const row = await getOpportunity(id);
        rows.set(id, { id, title: row?.title ?? null, company: row?.company ?? null });
      }
      opportunities.push(rows.get(id)!);
      const plan = await readPlanFor(id, ctx, plans);
      if (plan && findPlanTerm(plan, term)?.must_have === true) mustHave = true;
    }

    const recommendation = pass.error
      ? { answer: null, rule: null, note: `triage unavailable: ${pass.error}` }
      : recommend(pass.verdicts.get(key(term)), cvSourceReference(term, cvSource));

    terms.push({ ...item, term, recommendation, opportunities, must_have: mustHave });
  }

  return { ...base, terms };
}

/** GET /api/keywords/triage: the whole dry run, for the Rules screen. */
export async function getKeywordsTriage(ctx: ApiContext = {}): Promise<TriageReport> {
  const pass = await triagePass(ctx);
  if (!pass.report) throw new Error(`keyword triage could not load its context: ${pass.error}`);
  return pass.report;
}

export async function handle(req: ApiRequest, ctx: ApiContext): Promise<ApiResult | null> {
  const method = req.method.toUpperCase();
  const pathname = req.pathname.replace(/\/+$/, "") || "/";
  const query = req.query ?? new URLSearchParams();

  if (pathname === "/api/keywords/pending" && method === "GET") {
    return {
      status: 200,
      body: await getKeywordsPendingPlus({
        limit: query.get("limit"),
        offset: query.get("offset"),
        resume: query.get("resume"),
        q: query.get("q"),
        all: query.get("all"),
      }, ctx),
    };
  }

  if (pathname === "/api/keywords/triage") {
    if (method !== "GET") return { status: 405, body: { error: `${method} not allowed on ${pathname}` } };
    return { status: 200, body: await getKeywordsTriage(ctx) };
  }

  return null;
}
