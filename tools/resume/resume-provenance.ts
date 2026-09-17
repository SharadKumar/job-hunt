#!/usr/bin/env tsx
/**
 * resume-provenance.ts — deterministic source-provenance validator.
 *
 * This does not prove semantic truth. It enforces the auditable contract that
 * resume-writer must persist line-level source evidence for authored content,
 * and that cited source ranges exist in the current canonical profile files.
 */

import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { resolveProfileContext } from "../profile-context.ts";
import type { ResumeContent, ResumeSourceProvenance, SourceReference } from "../../templates/resume/_interface.ts";
import { loadComposition } from "./lib/composition-io.ts";
import { analyseCitations, runReanchorCli, WEAK_SCORE } from "./resume-reanchor.ts";

type Severity = "warn" | "fail";
type Issue = { severity: Severity; rule: string; detail: string };

function parseArgs(): Record<string, string> {
  const argv = process.argv.slice(2);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true";
    }
  }
  return out;
}

async function readText(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function add(issues: Issue[], severity: Severity, rule: string, detail: string): void {
  issues.push({ severity, rule, detail });
}

function lineCount(text: string): number {
  return text.split(/\r?\n/).length;
}

function validateRef(args: {
  issues: Issue[];
  ref: SourceReference;
  label: string;
  fileLineCounts: Map<string, number>;
}): void {
  const { issues, ref, label, fileLineCounts } = args;
  if (!ref?.file) {
    add(issues, "fail", "source_ref", `${label}: missing file`);
    return;
  }
  const count = fileLineCounts.get(ref.file);
  if (count === undefined) {
    add(issues, "fail", "source_ref", `${label}: unsupported source file '${ref.file}'`);
    return;
  }
  const [start, end] = ref.lines ?? [];
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > count) {
    add(issues, "fail", "source_ref", `${label}: invalid line range ${JSON.stringify(ref.lines)} for ${ref.file} (${count} lines)`);
  }
}

function validateRefs(args: {
  issues: Issue[];
  refs: SourceReference[] | undefined;
  label: string;
  fileLineCounts: Map<string, number>;
  required?: boolean;
}): void {
  const { issues, refs, label, fileLineCounts, required = true } = args;
  if (!refs?.length) {
    if (required) add(issues, "fail", "source_coverage", `${label}: no source references`);
    return;
  }
  refs.forEach((ref, index) => validateRef({ issues, ref, label: `${label}[${index}]`, fileLineCounts }));
}

function experienceKeys(xp: ResumeContent["experiences"][number]): string[] {
  return [
    `${xp.title}|${xp.company}|${xp.start}|${xp.end}`,
    `${xp.title} @ ${xp.company} (${xp.start}–${xp.end})`,
    `${xp.title}, ${xp.company}`,
    xp.title,
  ];
}

export type ProvenanceResult = {
  verdict: "pass" | "warn" | "fail";
  issues: Issue[];
  stats: {
    fail_count: number;
    warn_count: number;
    summary_refs: number;
    unsupported_claims: number;
    /** citations whose cited lines no longer carry the unit's distinctive vocabulary */
    weak_citations: number;
    /** units with a number the cited lines do not contain */
    number_unsupported: number;
  };
};

/**
 * Validate a composition's source provenance against the current profile files.
 * Never exits. `provenance` overrides `content.source_provenance` — callers that
 * read the `<prefix>.provenance.json` sidecar pass it explicitly.
 */
export async function runProvenance(args: { content: ResumeContent; profile?: string; provenance?: ResumeSourceProvenance | null }): Promise<ProvenanceResult> {
  const { content } = args;
  const profileContext = resolveProfileContext(args.profile);
  const issues: Issue[] = [];
  const provenance = args.provenance !== undefined ? args.provenance : content.source_provenance;

  if (!provenance) {
    add(issues, "fail", "source_provenance", "ResumeContent.source_provenance missing");
  }

  const cvSource = await readText(profileContext.cvSourcePath);
  const profile = await readText(profileContext.profileMdPath);
  const fileLineCounts = new Map<string, number>([
    [profileContext.cvSourcePath, lineCount(cvSource)],
    [profileContext.profileMdPath, lineCount(profile)],
    ["state/profile/cv-source.md", lineCount(cvSource)],
    ["state/profile/profile.md", lineCount(profile)],
  ]);

  if (provenance?.cv_source_hash && provenance.cv_source_hash !== sha256(cvSource)) {
    add(issues, "fail", "source_hash", `cv_source_hash does not match current ${profileContext.cvSourcePath}`);
  }
  if (provenance?.profile_hash && provenance.profile_hash !== sha256(profile)) {
    add(issues, "fail", "source_hash", `profile_hash does not match current ${profileContext.profileMdPath}`);
  }

  for (const claim of provenance?.unsupported_claims ?? []) {
    add(issues, "fail", "unsupported_claim", claim);
  }

  if (provenance) {
    validateRefs({ issues, refs: provenance.evidence?.summary, label: "summary", fileLineCounts, required: Boolean(content.summary) });

    content.highlights.forEach((_, index) => {
      validateRefs({
        issues,
        refs: provenance.evidence?.highlights?.[index],
        label: `highlights[${index}]`,
        fileLineCounts,
      });
    });

    for (const skill of content.skills) {
      validateRefs({
        issues,
        refs: provenance.evidence?.skills?.[skill.name],
        label: `skills['${skill.name}']`,
        fileLineCounts,
      });
    }
    validateRefs({
      issues,
      refs: provenance.evidence?.additional_skills_summary,
      label: "additional_skills_summary",
      fileLineCounts,
      required: Boolean(content.additional_skills_summary),
    });
    content.credentials?.forEach((_, index) => {
      validateRefs({
        issues,
        refs: provenance.evidence?.credentials?.[index],
        label: `credentials[${index}]`,
        fileLineCounts,
      });
    });

    for (const xp of content.experiences) {
      const key = experienceKeys(xp).find((candidate) => provenance.evidence?.experiences?.[candidate]);
      const evidence = key ? provenance.evidence.experiences[key] : undefined;
      if (!evidence) {
        add(issues, "fail", "source_coverage", `experience '${xp.title}' at '${xp.company}': no provenance entry`);
        continue;
      }
      if (xp.placement === "feature") {
        validateRefs({ issues, refs: evidence.summary, label: `experience '${xp.title}' summary`, fileLineCounts, required: Boolean(xp.summary) });
        xp.bullets.forEach((_, index) => {
          validateRefs({
            issues,
            refs: evidence.bullets?.[index],
            label: `experience '${xp.title}' bullets[${index}]`,
            fileLineCounts,
          });
        });
      } else {
        validateRefs({ issues, refs: evidence.one_liner, label: `experience '${xp.title}' one_liner`, fileLineCounts });
      }
    }
  }

  // Support checking: a cited range that still EXISTS may no longer contain the
  // text it was written against (the source was edited above it). See
  // resume-reanchor.ts; `--reanchor` repairs what it can.
  let weakCitations = 0;
  let numberUnsupported = 0;
  if (provenance?.evidence) {
    const sources = new Map<string, string>([
      [profileContext.cvSourcePath, cvSource],
      [profileContext.profileMdPath, profile],
      ["state/profile/cv-source.md", cvSource],
      ["state/profile/profile.md", profile],
    ]);
    const citations = analyseCitations({ content, provenance, sources });
    weakCitations = citations.weak.length;
    numberUnsupported = citations.numberUnsupported.length;
    for (const weak of citations.weak) {
      add(
        issues,
        "warn",
        "weak_citation",
        `${weak.unit}[${weak.refIndex}]: ${weak.ref.file}:${weak.ref.lines?.[0]}-${weak.ref.lines?.[1]} supports ${weak.score.toFixed(2)} of the cited text (< ${WEAK_SCORE})`,
      );
    }
    for (const item of citations.numberUnsupported) {
      add(
        issues,
        "fail",
        "number_unsupported",
        `${item.unit}: ${item.numbers.join(", ")} absent from the cited lines (${item.refs.map((r) => `${r.file}:${r.lines?.[0]}-${r.lines?.[1]}`).join(", ")})`,
      );
    }
  }

  const failCount = issues.filter((issue) => issue.severity === "fail").length;
  const warnCount = issues.filter((issue) => issue.severity === "warn").length;
  const verdict = failCount ? "fail" : warnCount ? "warn" : "pass";
  return {
    verdict,
    issues,
    stats: {
      fail_count: failCount,
      warn_count: warnCount,
      summary_refs: provenance?.evidence?.summary?.length ?? 0,
      unsupported_claims: provenance?.unsupported_claims?.length ?? 0,
      weak_citations: weakCitations,
      number_unsupported: numberUnsupported,
    },
  };
}

async function main() {
  const args = parseArgs();
  // `--reanchor` repairs shifted citations instead of validating them; `--write`
  // applies, otherwise it is a dry run.
  if (args.reanchor === "true") {
    process.exit(await runReanchorCli(args));
  }
  const contentPath = args["content-json"];
  if (!contentPath) {
    console.error("Usage: tsx tools/resume/resume-provenance.ts --content-json <path>");
    process.exit(2);
  }
  // Sidecar first (`<prefix>.provenance.json`), inline field for older artefacts.
  const loaded = await loadComposition(contentPath);
  const result = await runProvenance({ content: loaded.content, profile: args.profile, provenance: loaded.provenance });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.verdict === "pass" ? 0 : result.verdict === "warn" ? 1 : 2);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(3);
  });
}
