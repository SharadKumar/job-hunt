/**
 * tools/ui/resumes-api.ts - the Resumes screen's read-only JSON contract.
 *
 * The CV binder already has a data layer: `buildResumeIndexModel` in
 * tools/resume/index/model.ts reads every artefact a rendered positioning
 * leaves on disk (metadata, audit report, keyword plan, composition, critic
 * review) and returns one `ResumeCard` per positioning. This module reuses it
 * whole and does two things it cannot do:
 *
 *   1. flattens a card into the compact shape the browser needs, and
 *   2. turns the binder's on-disk relative links into API urls, because a
 *      browser talking to the local server cannot follow a filesystem path.
 *
 * AGENTS.md section 5: rendering and approval belong to resume-writer,
 * resume-critic and `npm run resume:approve`, all of them attended. Nothing
 * here writes, renders, approves or mutates anything. The screen shows state
 * and opens files; that is the whole of it.
 */

import { promises as fsp } from "node:fs";
import path from "node:path";

import { buildResumeIndexModel, type ResumeCard } from "../resume/index/model.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { loadResolvedResumes, type Resume } from "../resumes.ts";
import { loadKeywordClouds, resolveCloudsForType } from "../keyword-clouds.ts";

/** Extensions the file route will serve, and the type each goes out as. */
const FILE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".md": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

export type ResumePage = { page: number; src: string; fill: number | null; threshold: number; low: boolean };
export type ResumeGate = { name: string; verdict: string; reason: string | null };
export type ResumeCheck = { key: string; label: string; verdict: string; reason: string | null };
export type ResumeCloud = { id: string; label: string; weight: number; stale: boolean; age_days: number | null };

export type ResumeSummary = {
  id: string;
  label: string;
  /** The positioning's own headline from resumes.yaml, when it declares one. */
  positioning: string | null;
  stamp: { kind: string; text: string };
  approved_at: string | null;
  last_render_at: string | null;
  pages: ResumePage[];
  gates: ResumeGate[];
  checks: ResumeCheck[];
  critic: {
    verdict: string | null;
    round: number | null;
    findings_count: number;
    summary: string | null;
    /** The open findings, one line each, so the screen can show them rather
     * than only count them. `openCriticFindings` already flattens them. */
    findings: string[];
  };
  keywords: {
    must_have: { surfaced: number; total: number };
    renderable: { surfaced: number; total: number };
  };
  clouds: ResumeCloud[];
  files: { docx: string | null; pdf: string | null; md: string | null };
};

export type ResumesResponse = {
  profile: { id: string | null; name: string };
  resumes: ResumeSummary[];
};

/** A file the binder linked relatively; the API only needs its name. */
function baseNameOf(link: string | null | undefined): string | null {
  if (!link) return null;
  let decoded = link;
  try { decoded = decodeURI(link); } catch { /* a link that will not decode is used as-is */ }
  const name = decoded.split("/").pop() ?? "";
  return name || null;
}

/**
 * The url the browser fetches one artefact through. Both segments are escaped.
 *
 * Absolute, not relative. The server serves the app shell for every
 * extensionless path, so on a deep address like `#/resumes/evidence` a
 * relative `api/...` resolved against the wrong base and came back as HTML.
 * It is the same fix `api()` in app.js carries for the JSON routes.
 *
 * The token never rides in this url. The route sits behind the same bearer
 * gate as every other /api call, so the browser fetches it with the header and
 * opens the bytes as an object url (`openFile` in static/resumes.js). A token
 * in a query string would end up in the server log and in the address bar.
 */
export function fileUrl(resumeId: string, name: string): string {
  return `/api/resumes/${encodeURIComponent(resumeId)}/file/${encodeURIComponent(name)}`;
}

function linkFor(resumeId: string, link: string | null | undefined): string | null {
  const name = baseNameOf(link);
  return name ? fileUrl(resumeId, name) : null;
}

/**
 * Keyword coverage, in the two populations the screen shows as bars. The
 * applied keyword plan is the better source (it counts what landed on the
 * page); the audit's own block answers when a plan predates clouds.
 */
function coverageOf(card: ResumeCard): ResumeSummary["keywords"] {
  const kc = card.audit?.keyword_coverage ?? null;
  const plan = card.keywordPlan;
  const n = (...values: Array<number | null | undefined>) => values.find((v) => typeof v === "number") ?? 0;
  return {
    must_have: {
      surfaced: n(plan?.must_have_surfaced, kc?.must_have_surfaced),
      total: n(plan?.must_have_renderable, kc?.must_have_total),
    },
    renderable: {
      surfaced: n(plan?.surfaced_total, kc?.surfaced_total),
      total: n(plan?.renderable_total, kc?.renderable_total),
    },
  };
}

/**
 * Cloud freshness for one positioning. The binder's own cloud rows come from
 * the keyword plan and carry counts, not ages, so the shared clouds file is
 * read here instead: `resolveCloudsForType` is the same resolver the renderer
 * uses, so "stale" means on this screen exactly what it means at render time.
 */
async function cloudsOf(resume: Resume | undefined, card: ResumeCard, now: Date): Promise<ResumeCloud[]> {
  if (resume) {
    const file = await loadKeywordClouds().catch(() => null);
    if (file) {
      const resolved = resolveCloudsForType(resume.market_lens, file, now);
      if (resolved.length) {
        return resolved.map((c) => ({ id: c.id, label: c.label, weight: c.weight, stale: c.stale, age_days: c.age_days }));
      }
    }
  }
  // No yaml entry, or no cloud resolved: the plan still names what it used.
  return card.keywordClouds.map((c) => ({ id: c.id, label: c.label, weight: c.weight, stale: false, age_days: null }));
}

export type ResumesContext = { profileId?: string | null; now?: Date };

export async function getResumes(ctx: ResumesContext = {}): Promise<ResumesResponse> {
  const profileId = ctx.profileId ?? null;
  const now = ctx.now ?? new Date();
  const context = resolveProfileContext(profileId);
  // The binder writes relative links from `outPath`; this screen builds its own
  // urls, so the path only has to be stable, never written to.
  const model = await buildResumeIndexModel({ profileId, outPath: path.join(context.renderedResumesDir, "index.html") });
  const resolved = await loadResolvedResumes({ profileId }).catch(() => []);
  const byId = new Map(resolved.map((entry) => [entry.resume.id, entry.resume]));

  const resumes: ResumeSummary[] = [];
  for (const card of model.cards) {
    const resume = byId.get(card.id);
    resumes.push({
      id: card.id,
      label: card.label,
      positioning: resume?.display_headline?.trim() || null,
      stamp: { kind: card.stamp.kind, text: card.stamp.text },
      approved_at: card.status === "approved" ? card.statusDate : null,
      last_render_at: card.mtimes.composition ?? card.audit?.generated_at ?? null,
      pages: card.pages
        .map((page, index) => ({
          page: index + 1,
          src: linkFor(card.id, page.src),
          fill: page.fill,
          threshold: page.threshold,
          low: page.low,
        }))
        .filter((page): page is ResumePage => page.src !== null),
      gates: (card.audit?.gates ?? []).map((g) => ({ name: g.name, verdict: g.verdict, reason: g.reason })),
      checks: card.checks.map((c) => ({ key: c.key, label: c.label, verdict: c.verdict, reason: c.reason })),
      critic: {
        verdict: card.review.verdict,
        round: card.review.round,
        findings_count: card.openFindings.length,
        summary: card.review.summary,
        findings: card.openFindings,
      },
      keywords: coverageOf(card),
      clouds: await cloudsOf(resume, card, now),
      files: {
        docx: linkFor(card.id, card.links.docx),
        pdf: linkFor(card.id, card.links.pdf),
        md: linkFor(card.id, card.links.md),
      },
    });
  }

  return { profile: { id: model.profileId, name: model.profileName }, resumes };
}

export type ResumeFileResult =
  | { status: 200; file: string; contentType: string }
  | { status: 400 | 403 | 404; error: string };

/**
 * Resolve one artefact inside `state/profile/resumes/<id>/`.
 *
 * A name is a name: no separator, no dot-dot, no extension outside the
 * allowlist, and it must already exist as a regular file. Everything else is
 * refused before the filesystem is touched in anger, and the resolved path is
 * checked against the directory again afterwards so a symlink cannot walk out.
 */
export async function resolveResumeFile(
  resumeId: string,
  name: string,
  ctx: ResumesContext = {},
): Promise<ResumeFileResult> {
  const id = String(resumeId ?? "");
  const wanted = String(name ?? "");
  for (const part of [id, wanted]) {
    if (!part) return { status: 400, error: "both a resume id and a file name are required" };
    if (part.includes("/") || part.includes("\\") || part.includes("..") || part.startsWith(".")) {
      return { status: 403, error: "forbidden: a resume file is named, never pathed" };
    }
  }
  const ext = path.extname(wanted).toLowerCase();
  const contentType = FILE_TYPES[ext];
  if (!contentType) {
    return { status: 403, error: `forbidden: ${ext || "a file with no extension"} is not served from a resume folder` };
  }

  const dir = path.resolve(resolveProfileContext(ctx.profileId ?? null).renderedResumesDir, id);
  const file = path.resolve(dir, wanted);
  if (path.dirname(file) !== dir) return { status: 403, error: "forbidden: that path leaves the resume folder" };
  const real = await fsp.realpath(file).catch(() => null);
  if (!real || path.dirname(real) !== (await fsp.realpath(dir).catch(() => dir))) {
    return { status: 404, error: `not found: ${wanted}` };
  }
  const stat = await fsp.stat(real).catch(() => null);
  if (!stat?.isFile()) return { status: 404, error: `not found: ${wanted}` };
  return { status: 200, file: real, contentType };
}
