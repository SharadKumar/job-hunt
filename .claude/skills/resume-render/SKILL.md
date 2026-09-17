---
name: resume-render
description: Produce or preview the baseline CV for one resume positioning with full quality auditing. Use whenever the user says "render my CV", "make my CV for <resume>", "preview the <resume> CV", "show me what this looks like", "let me see the architect CV", "do a fresh render", or wants to compare templates ("how does minimalist render this?"). Also use when the /apply orchestration signals a resume baseline is missing or stale and a re-render is needed before drafting. The skill always routes through the resume-writer subagent which holds the quality contract — never call `npm run resume:render:raw` directly for a production artefact, that bypasses auditing. For batch baselines across ALL resumes, prefer /resume-review.
---

# /resume-render — produce one resume positioning's baseline through resume-writer

## What this skill does

Triggers the resume-writer subagent for one resume positioning. resume-writer handles everything: template resolution, content loading, rendering, structural + visual checks, auto-fixing what's auto-fixable, surfacing what isn't. This skill is the user-facing entry — it parses the user's request into a resume-writer invocation, surfaces resume-writer's quality report, and handles the approve / edit / re-render decision with the user.

## Why this exists as a skill

The deterministic dispatcher (`npm run resume:render:raw -- --resume <id>`) produces files but doesn't audit them. Calling it directly leaves you with artefacts whose quality is unknown — and the caller (you / the user) has no contract about whether they're fit-to-send. resume-writer as a subagent IS the contract. This skill exists to make sure that contract is honoured every time the user wants a CV.

## Reference: quality checks (universal)

The canonical list of CV quality checks lives at `references/quality-checks.md` (next to this SKILL.md). resume-writer reads it on every invocation. Checks are template-agnostic — they apply to any CV regardless of which template rendered it. Per-template overrides (rare) are declared in `templates/resume/<name>/quality-checks.md` and merge over the universal ones.

Research-backed template policy lives in `docs/resume-research/claims.yaml` and `templates/resume/<name>/rubric.yaml`. resume-writer must load both. The rubric owns safe visible headings, page budget, density, skills grouping, and bullet-quality constraints. The deterministic gate is `npm run resume:audit` (one render, one browser, every check, one compact report); `resume:evaluate`, `resume:page-fill` and `resume:to-images` survive only as thin CLIs over the same library.

When you invoke resume-writer, you do NOT need to re-declare these checks; resume-writer reads the references itself. This skill's job is to invoke resume-writer and surface its quality report — not to run checks itself.

## Sequence

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

If `market_alignment.confirmation_needed` or `market_alignment.open_questions` already exist for the resume and the current CLI cannot show structured questions, stop before asking inline. Tell the user to rerun the judgement/review step in a mode exposing structured questions: Claude Code `AskUserQuestion` or Codex `request_user_input`. Default mode is for rendering and validation, not collecting judgement answers when structured tooling is unavailable.

1. **Parse the user's request**. Extract:
   - `resume-id` (required — match against `state/profile/resumes.yaml`; if ambiguous, ask).
   - Optional `profile-id` if the user names a team member; use `state/profiles/<profile-id>/` paths for that render. Default remains `state/profile/`.
   - Optional `format-id` for team profiles. If omitted, use `state/org/team.yaml` → `default_resume_format`; Individual mode ignores org formats.
   - Template override (if user says "render with minimalist" etc., extract the template name).
   - Flavours wanted (default both `ats` + `presentation`).
   - Max pages (default 3, or whatever the resume's page policy suggests).

1.4. **Keyword clouds are current** (mandatory gate — market narrative first; run before the evidence interview, on every render).

   A positioning is only renderable against current keyword clouds: the weighted capability, domain and tooling clouds it references in `market_lens.clouds` (resolved from `state/org/keyword-clouds.yaml`), each researched from the title family outward, qualified against `cv-source.md`, with the unmatched-but-important terms already put to the user. Without them the writer composes against our guesses rather than the market's vocabulary.

   ```
   npm run resume:context -- --resume <resume-id> [--profile <profile-id>]
   ```

   Read the brief's `clouds` block (`present`, `missing`, `stale`, `term_count`, `unknown_cloud_ids`, and a `clouds[]` row per referenced cloud with its `id`, `label`, `weight`, `refreshed_at`, `age_days` and `stale`):
   - `missing: true` (the positioning references no clouds) → **do not render**. Run the `/resume-strategy` cloud refresh (steps 3b + 3c) for this positioning now, in this session, then re-run the command and continue.
   - `stale: true` (a load-bearing cloud, weight >= 4, is older than `stale_after_days` or has no readable `refreshed_at`) → **do not render**. Refresh that cloud, naming it, then re-run. Remember a cloud is shared: refreshing it moves every positioning that references it.
   - `unknown_cloud_ids` non-empty → the type points at a cloud that does not exist. Fix the reference (or create the cloud) before rendering.
   - Otherwise state the cloud count, the total term count and the heaviest cloud's refresh date in one line and continue to 1.5.

   `npm run resume:audit` enforces the same rule as `gates.clouds` (fail when the positioning references none, warn when a load-bearing cloud is stale), so skipping this step only moves the stop later and wastes a render.

1.5. **Proactive keyword plan + evidence interview** (the standing gap-filling pass — run before spawning resume-writer, every baseline render).

   The user has done far more than `cv-source.md` records, so a term the market wants and the corpus lacks is usually missing evidence, not a missing skill. Turn that into questions here, before the writer composes, so the evidence exists before the term renders.

   a. Run `npm run resume:keywords -- --resume <resume-id> [--profile <profile-id>] --proactive`. The plan lands at `<profile-dir>/resumes/<resume-id>/keyword-plan.json` and draws its questions from the `confirm` tier of the type's keyword clouds, `market_lens.must_signal` gaps, and mined terms absent from the corpus, grouped by cloud and ordered by cloud weight then JD frequency. The plan's `clouds[]` gives the per-cloud coverage (`total`, `renderable`, `surfaced`, `questions`) so you can say which cloud the gap is in.

   b. If `questions` is non-empty, ask via `AskUserQuestion` in batches of **at most 4**, highest-ranked first, with exactly these four reusable options:
      - `Confirm and update source (Recommended)`
      - `Bring in as familiarity` — the user did not deliver it but can credibly prepare and speak to it; recorded as `--status familiarity`, it renders once in a familiarity-framed skills line and is listed under `interview_prep_terms`, never as delivered work
      - `Not applicable`
      - `Unsure / keep pending`

      Question text = the plan's `question` plus its `evidence_hint` (the roles where the term plausibly occurred) and its `why` (what the market wants it for). The answer is a yes/no plus optional detail — never an open-ended "tell me about X". Dedupe questions sharing an `alias_group`.

   c. Record every answer: `npm run resume:keyword-confirm -- record --plan <plan-path> --term "<term>" --status confirmed|not_applicable|familiarity|pending --origin attended`. Never hand-edit `market-confirmations.yaml`.

   d. For each `Confirm and update source`, show the proposed one-bullet `cv-source.md` patch (`proposed_phrasing`) at the role in `evidence_hint` and ask in batches of at most 4: `Apply this wording (Recommended)` / `Edit wording` / `Skip`. On Apply/Edit run `npm run resume:keyword-confirm -- apply-patch --term "<term>" --resume <resume-id> --role-heading "<heading substring>" --bullet "<final text>"` (add `--skills` for a Skills-section fact); it prints the diff it applied, refuses duplicates, and clears `source_update_required`. On Skip the row stays `confirmed` but unrenderable. Remind the user the master `.docx` must carry the same fact or `/refresh-cv` drops it.

   e. `Bring in as familiarity` records `--status familiarity`: a term the user did not deliver but can credibly prepare and speak to. No source patch. The re-run plan marks it `preppable` with `render_as: "familiarity"`, so resume-writer renders it once in a familiarity-framed skills line ("Familiar with ...", "Working knowledge of ...", "Prepared on ...") and lists it under `interview_prep_terms`. It is answered, so it is never re-asked. `Not applicable` suppresses the term permanently. `Unsure / keep pending` leaves a `pending` row that `/resume-review` and `/review-drafts` will offer again — don't re-ask it in this run.

   f. Re-run the `--proactive` command so the plan reflects the patched corpus, then pass `--keyword-plan <plan-path>` to resume-writer in step 2 as a surfacing contract.

   If the current CLI cannot show structured questions, do not ask inline: run `npm run resume:keyword-confirm -- queue --plan <plan-path> --origin daily`, render without those terms, and tell the user to rerun in structured-question mode.

2. **Invoke the resume-writer subagent** with `subagent_type: resume-writer`. Pass:
   - The resume id and any template override.
   - The format id for team/client profile renders when resolved.
   - The expected output dir: default `state/profile/resumes/<resume-id>/`, or `state/profiles/<profile-id>/resumes/<resume-id>/` for team profiles.
   - The flavours + max-pages.
   - `--keyword-plan <profile-dir>/resumes/<resume-id>/keyword-plan.json` from step 1.5, described as a surfacing contract: every grounded / alias-grounded / confirmed term appears at least once, in the plan's `jd_form` spelling, and both forms where `render_both_forms` is set. It never authorises a fact the corpus lacks.
   - When a prior `*.composition.json` exists in the output dir, say so: the writer seeds from it (plus its `*.provenance.json` sidecar and `bench`) and edits, rather than recomposing.

   resume-writer does the rest: one `resume:context` brief, one composition with a bench, then `npm run resume:audit --auto-fit` cycles (at most `render_efficiency.max_full_render_iterations`). Don't second-guess its loop; it owns that.

3. **Enforce report completeness** (apply `references/enforce-quality-report.md`):
   - Parse resume-writer's JSON.
   - Compare verdicts in `checks.structural` + `checks.visual` against the declared check ids in `references/quality-checks.md` (universal) + `templates/resume/<template>/quality-checks.md` (per-template overrides).
   - Confirm `checks.structural.research_rubric` is present and reflects the `resume:audit` evaluate verdict.
   - Confirm `checks.structural.source_provenance` is present, `artefacts.composition_json` and `artefacts.provenance_json` exist, and the sidecar carries `source_provenance` with no `unsupported_claims`.
   - Confirm `audit.cycles` does not exceed `render_efficiency.max_full_render_iterations`; if it does, the writer ignored its budget and the report gets `human_review_needed: true`.
   - If any declared id is missing a verdict: reject. Either re-invoke resume-writer with the missing-ids list, or surface a hard error to the user.
   - Only accept reports where every declared id has a verdict (pass / warn / fail / skip / error).
   - **Independently re-run the deterministic gates. Do NOT trust the writer's prose verdicts.** The writer has historically narrated a tool `fail` down to "warn (acceptable)" (ragged skill lines, JD-injected terms). So the orchestrator re-runs the tools itself against the composition the writer left on disk (never into a fresh out-dir, so artefacts and metadata stay in place):
     ```
     npm run resume:audit -- --resume <id> --content-json <profile-dir>/resumes/<id>/*.composition.json --out-dir <profile-dir>/resumes/<id> --strict-line-units true [--profile <p>] [--format <f>] --keyword-plan <plan-path>
     npm run resume:keywords -- --resume <id> --proactive --composition <composition.json>
     npm run resume:term-grounding -- --content-json <composition.json> --keyword-plan <plan-path>
     ```
     `resume:audit` exits 2 on any evaluate `fail` (ragged units, orphans, page budget, rubric), and its `gates` block carries provenance, ATS and term-grounding verdicts; `resume:keywords --composition` exits 1 when coverage warns; `resume:term-grounding --keyword-plan` fails any term the plan did not authorise. If any of these exit non-zero with a `fail`-severity issue that the report labelled pass/warn, treat the report as untrustworthy: re-invoke resume-writer naming the specific failing units/terms from the audit's `failing_units`, or surface to the user. A green prose report over a red tool exit is a hard stop.

3.5. **Independent content review (mandatory before approval)**.

   The gates in step 3 decide mechanics. They cannot see two adjacent bullets saying the same thing under different prefixes, a number the summary and a bullet disagree on, or a framing the profile's editorial rules forbid in meaning rather than in strings. Invoke the critique skill, which owns that whole loop:

   ```
   Skill(skill: "resume-critique", args: "<resume-id> --rounds 2 [--profile <profile-id>]")
   ```

   It spawns the resume-critic subagent, persists every round to `<prefix>.critic.json`, then applies, re-anchors and re-audits in ONE call — `npm run resume:edit -- --resume <id> --edits <findings-or-edits>.json` — re-runs the critic once, and stamps `metadata.json`. Do not embed those steps here and do not spawn resume-critic yourself.

   - `pass` → continue to step 4 and offer approval.
   - `revise` at the round cap → continue, but carry the open findings into step 4 and into the question in step 5, and set `human_review_needed: true`.
   - `block` → do NOT offer approval. Surface the findings per the critique skill's step 4 and stop.

   `npm run resume:approve` independently refuses when the critic verdict is missing, is `block`, or was recorded against a different composition, so skipping this step does not produce an approved baseline. It produces a confusing error.

4. **Surface to the user**:
   - The artefact paths (with `open <path>` commands they can copy).
   - The composition JSON path, its `*.provenance.json` sidecar, and the `*.audit.json` path so source evidence and measurements can be audited when the user challenges content.
   - `audit.cycles` and `audit.auto_fit` (ops applied, why it stopped), so the user sees how much of the fit was deterministic.
   - A 1-line summary of each check (`structural` block + `visual` block).
  - A short provenance summary: source file hash if available, unsupported claim count, and any source gaps.
   - The resolved format when present, e.g. `client-profile-one-pager`, so the user can distinguish a client submission profile from a job-market baseline.
   - Any `market_alignment.confirmation_needed` questions as explicit review actions. These are judgement questions for the user; they are not rendered claims yet.
   - Any `market_alignment.open_questions` as source-completion questions. These may not block the current render, but answering them can unlock stronger or more precise wording in future renders.
   - Any `source_update_required` market signals separately: these were already confirmed earlier, so do not ask again; tell the user the canonical CV source still needs the fact added.
   - Any suppressed `declined` / `not_applicable` market signals only if useful for audit; do not reopen them by default.
   - Keyword coverage from the re-run plan: `surfaced_pct` / `renderable_pct` of must-have terms, the must-have terms that are renderable but were left **unsurfaced** by the writer (name them — that's a writer defect, not a content gap), and the count of keyword questions still `pending`.
   - Any auto-fixes that were applied (so the user knows the loop did something).
   - The critic verdict, the round count, and every open finding the critique skill reported, with the path to `<prefix>.critic.json`.
   - The `human_review_needed` flag prominent.
   - If editorial-rules.md was consulted (resume-writer reports `editorial_rules_applied: true`), note it.

5. **Ask via the active CLI's structured question tool**:
   - Claude Code: use `AskUserQuestion`.
   - Codex: use `request_user_input` when available.
   - Do not dump confirmation/open questions as inline text if a structured question tool is available.
   - For each market gap, use choices like "Confirm and update source", "Not applicable", "Bring in as familiarity", and "Unsure / keep pending"; the tool's custom/Other answer captures detail.
   - Approval is offered only after a critic `pass`. On `revise` at the cap, the options must name the open findings; on `block`, approval is not among the options at all.
   - If `human_review_needed: false` and all checks pass:
     "Open the artefacts and eyeball — Approve baseline (recommended) / Re-render with a different template / Edit before approving / Cancel?"
   - If `human_review_needed: true` with specific failures:
     Reflect the specific issues in the options. E.g. "Bullet density too sparse on this resume — Retag bullets to fix root cause (recommended) / Switch resume positioning / Approve thin baseline anyway / Cancel?"

6. **Act on the answer**:
   - **Approve** → `npm run resume:approve -- --resume <id>`. Updates metadata, snapshots `cv.md` for future diffs.
   - **Re-render with different template** → re-invoke this skill with the override.
   - **Edit before approving** → apply `references/capture-editorial-edits.md`:
     - Ask "What changed?" with structured options (bullet removed / experience demoted / phrasing changed / summary edited / multiple).
     - Append the entry to `state/profile/resumes/<resume-id>/editorial-rules.md`.
     - Re-invoke this skill — resume-writer will read the updated editorial-rules.md on its next composition.
     - On threshold crossing (same pattern twice in 7 days): surface promotion-to-global option per the procedure.
   - **Answer confirmation/open questions** → append/update the answer in `<profile-dir>/market-confirmations.yaml` with `status: confirmed`, `declined`, `not_applicable`, or `pending`. If confirmed, update the canonical source first (`<profile-dir>/cv-source.md` or `/refresh-cv` for the default profile), then re-invoke this skill. Never edit the rendered resume to add the newly confirmed fact directly.
   - **Cancel** → leave state unchanged.

## Boundaries

- **Don't bypass resume-writer.** Even for a quick preview, route through the subagent. `resume:audit` and the dispatcher are for resume-writer's own use and for your independent re-run in step 3, never for producing a production artefact.
- **Don't auto-approve.** Approval is an explicit user action, even if resume-writer reports all green.
- **Don't offer approval before the critique skill has returned a pass.** A green gate row is not a read document.
- **Don't run the critic loop inline.** `/resume-critique` owns the rounds, the persistence and the re-audit; duplicating it here is how the two copies drift.
- **Don't argue with resume-writer's report.** If resume-writer says `human_review_needed: true`, surface the issues. Don't try to "fix" things outside its loop.
- **Don't edit canonical content as a workaround.** If a quality issue traces to bullet content, the fix is upstream (retag, update summary, edit experience file via `/onboarding`, `/resume-strategy`, or `/refresh-cv`), not editing the rendered output.

## When to invoke vs decline

Invoke this skill when the user wants one resume's CV produced or previewed with quality auditing.

Decline (route elsewhere):
- "Render all my baselines" → suggest `/resume-review` instead (batch flow with per-positioning approval).
- "Tailor this CV for opportunity X" → that's the `/apply` orchestration's job; not this skill.
- "Edit my CV bullets" → that's a profile change; route to `/refresh-cv` (which re-runs `markdownify:cv` against the master .docx) or hand-editing the master CV at `~/Documents/Resume/master-cv.docx` directly.

## Output to the user

Short structured response:

```
Resume:    <id>  (template: <name>, format: <format-id|none>, mode: baseline)
Artefacts: state/profile/resumes/<id>/
  open state/profile/resumes/<id>/resume_<profile-slug>_<id>.docx
  open state/profile/resumes/<id>/resume_<profile-slug>_<id>.pdf

Checks:    structural pages=pass(2) ats=pass sections=pass density=pass artefacts=pass
           visual    dates_italicised=pass section_order=pass
Audit:     2 cycles, auto-fit applied 3 ops (restore_bullet x2, add_skill_item)
Keywords:  must-have renderable 75%, surfaced 88%, 2 questions pending
Review:    critic pass (2 rounds, 3 findings applied, 0 open)
Status:    ready for human review

[Structured question: Approve / Re-render with different template / Edit content / Cancel]
```
