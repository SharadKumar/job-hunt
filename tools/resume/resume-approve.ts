#!/usr/bin/env tsx
/**
 * cv-approve.ts — mark a resume baseline CV as approved.
 *
 * Approval = a content_hash snapshot stored in metadata.json. If any
 * rendering input changes later (bullets edited, resume summary tweaked,
 * skills added), the new content_hash diverges and the status becomes
 * "stale" — the drafter warns the user to re-review.
 *
 * CLI:
 *   tsx tools/resume/resume-approve.ts --resume <id>           # approve current render
 *   tsx tools/resume/resume-approve.ts --resume <id> --skip-critic  # approve without a critic pass (logged)
 *   tsx tools/resume/resume-approve.ts --resume <id> --revoke  # clear approval
 *   tsx tools/resume/resume-approve.ts --status                # status for all resumes
 *   tsx tools/resume/resume-approve.ts --check <id>            # exit 0 approved, 1 stale, 2 fresh/missing
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getResume } from "../resumes.ts";
import { resolveProfileContext } from "../profile-context.ts";
import { compositionContentHash } from "./lib/composition-io.ts";

async function loadMeta(resumeId: string, perResumeDir: string): Promise<any | null> {
  try { return JSON.parse(await fs.readFile(path.join(perResumeDir, resumeId, "metadata.json"), "utf8")); }
  catch { return null; }
}

async function saveMeta(resumeId: string, meta: any, perResumeDir: string): Promise<void> {
  await fs.mkdir(path.join(perResumeDir, resumeId), { recursive: true });
  await fs.writeFile(path.join(perResumeDir, resumeId, "metadata.json"), JSON.stringify(meta, null, 2));
}

async function listResumes(perResumeDir: string): Promise<string[]> {
  try { return (await fs.readdir(perResumeDir)).filter((d) => !d.startsWith(".")); }
  catch { return []; }
}

type RenderedArtefacts = {
  docx: string | null;
  pdf: string | null;
  html: string | null;
  md: string | null;
  composition_json: string | null;
  provenance_json: string | null;
};

async function findRenderedArtefacts(resumeId: string, perResumeDir: string): Promise<RenderedArtefacts | null> {
  const dir = path.join(perResumeDir, resumeId);
  const files = await fs.readdir(dir).catch(() => [] as string[]);
  const pick = (ext: string) => files.find((f) => f.endsWith(ext) && !f.startsWith(".")) ?? null;
  const artefacts = {
    docx: pick(".docx"),
    pdf: pick(".pdf"),
    html: pick(".html"),
    md: pick(".md"),
    composition_json: pick(".composition.json"),
    provenance_json: pick(".provenance.json"),
  };
  if (!artefacts.docx && !artefacts.pdf && !artefacts.html && !artefacts.md) return null;
  const abs = (f: string | null) => (f ? path.join(dir, f) : null);
  return {
    docx: abs(artefacts.docx),
    pdf: abs(artefacts.pdf),
    html: abs(artefacts.html),
    md: abs(artefacts.md),
    composition_json: abs(artefacts.composition_json),
    provenance_json: abs(artefacts.provenance_json),
  };
}

async function inferMetaFromRendered(resumeId: string, perResumeDir: string, profileId?: string | null): Promise<any | null> {
  const artefacts = await findRenderedArtefacts(resumeId, perResumeDir);
  if (!artefacts) return null;
  const resume = await getResume(resumeId, { profileId });
  const h = createHash("sha256");
  h.update(`rendered-baseline:${resumeId}\n`);
  // Hash the deterministic SOURCE artefacts only — md, html, docx. The PDF is
  // derived from the html via Playwright Chromium and its bytes are non-deterministic
  // (Chromium embeds a creation timestamp), so hashing it would make
  // approval perpetually stale.
  for (const p of [artefacts.md, artefacts.html, artefacts.docx].filter(Boolean) as string[]) {
    h.update(path.basename(p));
    h.update(await fs.readFile(p));
  }
  const statPath = artefacts.md ?? artefacts.html ?? artefacts.docx ?? artefacts.pdf!;
  const stat = await fs.stat(statPath);
  // Composition + provenance sidecar hashed together and kept separate from
  // content_hash on purpose: folding them in would flip every previously
  // approved baseline to "stale" the moment the sidecar split landed.
  const compositionHash = artefacts.composition_json ? await compositionContentHash(artefacts.composition_json) : null;
  return {
    resume_id: resumeId,
    template: resume?.template ?? null,
    last_render_at: stat.mtime.toISOString(),
    content_hash: h.digest("hex"),
    composition_hash: compositionHash,
    approved_at: null,
    approved_hash: null,
    approval_status: "fresh",
    artefacts,
    metadata_source: "rendered-artifact-import",
  };
}

/**
 * The critic gate. Deterministic gates cannot see duplicated meaning, a
 * contradicted number, or a claim the cited lines do not carry, so an approval
 * without an independent content review is an approval of unknown content.
 * Refusing here (rather than only in the skill) makes the gate hold for any
 * caller, including a future one nobody has written yet.
 *
 * Returns null when approval may proceed, or the reason it may not.
 */
async function criticBlockReason(resumeId: string, perResumeDir: string): Promise<string | null> {
  const meta = await loadMeta(resumeId, perResumeDir);
  const critic = meta?.critic ?? null;
  if (!critic || !critic.verdict) {
    return `no critic review on record for '${resumeId}'. Run the resume-critique skill (\`resume-critique ${resumeId}\`) before approving, or pass --skip-critic to approve without one.`;
  }
  if (critic.verdict === "block") {
    return `the resume-critic returned 'block' on round ${critic.round ?? "?"} (${critic.at ?? "unknown time"}). Resolve the findings in the *.critic.json beside the composition, then re-run the critic. --skip-critic overrides.`;
  }
  // Find the composition directly rather than through findRenderedArtefacts:
  // that helper returns null unless a rendered docx/pdf/html/md is present, and
  // a gate that quietly opens when it cannot find its evidence is not a gate.
  const dir = path.join(perResumeDir, resumeId);
  const compositionFile = (await fs.readdir(dir).catch(() => [] as string[]))
    .find((f) => f.endsWith(".composition.json") && !f.startsWith("."));
  const current = compositionFile ? await compositionContentHash(path.join(dir, compositionFile)) : null;
  if (current && critic.composition_hash && current !== critic.composition_hash) {
    return `the critic reviewed a different composition (reviewed ${String(critic.composition_hash).slice(0, 12)}, on disk ${current.slice(0, 12)}). The CV changed after the review, so re-run the resume-critique skill. --skip-critic overrides.`;
  }
  return null;
}

async function approve(resumeId: string, perResumeDir: string, profileId?: string | null, skipCritic = false): Promise<void> {
  const blocked = await criticBlockReason(resumeId, perResumeDir);
  if (blocked && !skipCritic) {
    console.error(`Refusing to approve: ${blocked}`);
    process.exit(1);
  }
  const m = await loadMeta(resumeId, perResumeDir) ?? await inferMetaFromRendered(resumeId, perResumeDir, profileId);
  if (!m) { console.error(`No baseline for '${resumeId}' — run /resume-render first.`); process.exit(2); }
  if (blocked && skipCritic) {
    // Logged into metadata, not just printed: an unreviewed approval must stay
    // visible to the binder and to whoever reads this file next.
    m.critic_skipped = { at: new Date().toISOString(), reason: blocked };
    console.error(`[resume-approve] --skip-critic: approving without a critic pass. Reason it would have been refused: ${blocked}`);
  }
  m.approved_at = new Date().toISOString();
  m.approved_hash = m.content_hash;
  m.approval_status = "approved";
  await saveMeta(resumeId, m, perResumeDir);
  console.log(JSON.stringify({ resume: resumeId, approval_status: "approved", approved_at: m.approved_at, hash: m.content_hash.slice(0, 12) }, null, 2));
}

async function revoke(resumeId: string, perResumeDir: string, profileId?: string | null): Promise<void> {
  const m = await loadMeta(resumeId, perResumeDir) ?? await inferMetaFromRendered(resumeId, perResumeDir, profileId);
  if (!m) { console.error(`No baseline for '${resumeId}'.`); process.exit(2); }
  m.approved_at = null;
  m.approved_hash = null;
  m.approval_status = "fresh";
  await saveMeta(resumeId, m, perResumeDir);
  console.log(JSON.stringify({ resume: resumeId, approval_status: "fresh" }, null, 2));
}

async function status(perResumeDir: string, profileId?: string | null): Promise<void> {
  const ids = await listResumes(perResumeDir);
  const out = await Promise.all(ids.map(async (id) => {
    const m = await loadMeta(id, perResumeDir) ?? await inferMetaFromRendered(id, perResumeDir, profileId);
    if (!m) return { id, status: "missing" };
    return {
      id,
      status: m.approval_status,
      approved_at: m.approved_at,
      content_hash: m.content_hash?.slice(0, 12),
      approved_hash: m.approved_hash?.slice(0, 12),
      metadata_source: m.metadata_source,
    };
  }));
  console.log(JSON.stringify(out, null, 2));
}

async function check(resumeId: string, perResumeDir: string, profileId?: string | null): Promise<void> {
  const m = await loadMeta(resumeId, perResumeDir) ?? await inferMetaFromRendered(resumeId, perResumeDir, profileId);
  if (!m) { console.error(`No baseline for '${resumeId}'`); process.exit(2); }
  if (m.approval_status === "approved") process.exit(0);
  if (m.approval_status === "stale") { console.error(`stale — re-review needed`); process.exit(1); }
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2);
  const a: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
  }
  const context = resolveProfileContext(a.profile);
  const perResumeDir = context.renderedResumesDir;
  if (a.status === "true") return status(perResumeDir, a.profile);
  if (a.check) return check(a.check, perResumeDir, a.profile);
  const resumeId = a.resume;
  if (resumeId && a.revoke === "true") return revoke(resumeId, perResumeDir, a.profile);
  if (resumeId) return approve(resumeId, perResumeDir, a.profile, a["skip-critic"] === "true");
  console.error("Usage: tsx tools/resume/resume-approve.ts [--profile <id>] (--status | --check <id> | --resume <id> [--revoke] [--skip-critic])");
  process.exit(2);
}

main().catch((e) => { console.error(e); process.exit(1); });
