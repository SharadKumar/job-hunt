# Quality-report completeness enforcement (#9)

Shared procedure used by both `/resume-render` and `/resume-review` skills. After resume-writer returns its JSON quality report, validate the report is COMPLETE before surfacing it to the user. A missing check id is worse than a failing one: failures surface, omissions hide.

## Procedure

### 1. Collect the declared check ids

Read both files (the second is optional, may not exist):

- `.claude/skills/resume-render/references/quality-checks.md`: universal checks (applies to every CV regardless of template)
- `templates/resume/<template>/quality-checks.md`: per-template overrides (where `<template>` is the resume's chosen template from `resumes.yaml` / `resume-types.yaml`)

Each declares one or more checks via `### <check-id>` headings. Extract the set of all declared check ids. Per-template can add new ids; per-template can `skip` a universal id; if per-template `skip`s, the id still must appear in the report (as `verdict: "skip"`), not be omitted. `npm run resume:context -- --resume <id>` returns the same set under `check_ids`, bucketed structural / visual / skipped; use it rather than re-parsing the markdown by hand.

Two structural ids added 2026-09-10 are keyword-plan dependent: `jd_keyword_coverage` and `screener_surface_present`. They are `skip` only when no keyword plan applies to the render; when a plan was passed to resume-writer they must carry pass / warn.

### 1b. Where verdicts come from

Structural verdicts are read off deterministic tool output, never off the writer's prose: `npm run resume:audit` (its `verdict`, `gates.evaluate`, `gates.provenance`, `gates.ats`, `gates.term_grounding`, `pages`, `failing_units`) and `npm run resume:keywords -- --composition` (`coverage`, `screener_surface`). Visual verdicts come from the writer's PNG inspection. When the writer's structural verdict disagrees with the tool exit, the tool wins and the report is untrustworthy.

### 2. Validate resume-writer's report

resume-writer's report shape (per its operating contract at `agents/resume-writer.md`):
```json
{
  "checks": {
    "structural": { "<check-id>": "pass|warn|fail|skip|error", ... },
    "visual":     { "<check-id>": "pass|warn|fail|skip|error", ... },
    "visual_notes": ["..."]
  },
  ...
}
```

Flatten `checks.structural` and `checks.visual` into one set of `{id: verdict}` pairs. Compare against the declared set from step 1.

- Every declared id must appear with a non-empty verdict.
- Unexpected ids (in report but not declared) → warn, but accept.
- Missing ids → reject the report.
- `artefacts.composition_json`, `artefacts.provenance_json` and `artefacts.audit_json` must exist on disk; `audit.cycles` must not exceed the profile's `render_efficiency.max_full_render_iterations`.

### 2b. The `critic` field

A complete gate row is not a read document. After the report validates and the gates in step 1b re-run green, the calling skill invokes `resume-critique <id>`, which spawns the resume-critic subagent and persists `<prefix>.critic.json`.

An accepted report carries a `critic` field, filled from that review, not from the writer (the writer never reviews itself):

```json
"critic": {
  "verdict": "pass | revise | block",
  "round": 2,
  "at": "<ISO timestamp>",
  "composition_hash": "<hash of the composition that was reviewed>",
  "open_findings": ["<kind> at <unit_path>: <why>"],
  "critic_json": "<absolute path to <prefix>.critic.json>"
}
```

Rules:
- Missing `critic`, or a `critic.verdict` of `block`, means the report is NOT accepted. `block` is surfaced to the user with the findings; it is never narrated into an approval.
- `revise` is accepted only at the round cap, only with `open_findings` populated, and only with `human_review_needed: true`.
- `composition_hash` must equal `compositionContentHash(<prefix>.composition.json)` as it stands now. A mismatch means the CV changed after the review, so the review is void and the critique skill re-runs.
- The same three conditions are enforced independently by `npm run resume:approve`, which exits 1 rather than approving. The field here exists so the skill catches it before it asks the user a question it cannot honour.

### 3. On rejection: two strategies

**Strategy A: re-invoke resume-writer with explicit instruction** (preferred when there's budget):
- Spawn resume-writer again with the same target + a note listing the missing check ids: "Your prior report omitted verdicts for: [list]. Re-render OR re-audit and return a complete report including verdicts for these ids."
- Accept the second report if complete; else fall through to Strategy B.

**Strategy B: hard error to user**:
- Surface to the user: "resume-writer's quality report is incomplete, missing verdicts for: [list]. The artefact has been rendered but the quality contract isn't satisfied. Options: accept the partial audit (review the artefact yourself for the missing checks) / re-invoke resume-writer / cancel."
- Use AskUserQuestion. Don't silently approve.

### 4. On acceptance

Pass the complete report to the next step in the skill (the approve/edit/skip decision).

## What this guards against

- resume-writer in low-context mode skipping visual checks
- resume-writer trusting structural checks and forgetting per-template ones
- a future resume-writer prompt change that drops a check id
- silent regression where a check passes everywhere because it stopped being run
- an approval offered on a CV that every machine liked and no reader ever read

The contract is "every declared check has a verdict in every report", enforced at the skill layer, not just hoped for in the subagent prompt.
