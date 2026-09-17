---
name: apply
description: Submit one specific opportunity end-to-end interactively, right now. Use when the user names a specific opportunity and says "apply to this one", "submit this", "send my application for X", "push this through now", or supplies an opportunity-id with intent to finalise. Also the production entry for Stage 2 (per-opportunity package authoring + submission). Always requires explicit per-submission confirmation; honours validation gate and screening-answer flow. Argument is the opportunity-id.
---

# /apply — assemble + submit one opportunity's application package

One-shot, synchronous. The skill **orchestrates** Stage 2 — it spawns `resume-writer` (only if the opportunity needs JD-tailoring) AND `cover-letter-writer` as **peer subagents**, then bundles the package, then submits (or routes to manual). The skill is the orchestrator because subagents can't spawn other subagents — the apply flow needs three concurrent subagents (resume-writer, cover-letter-writer, optionally submission-runner), and only the skill layer can coordinate them.

> **Architectural note**: package assembly is now skill-level orchestration. Any flow that needs to assemble an application package (this skill, `/submit-approved`, daily orchestrator) goes through the same peer-writer pattern documented here.

## Inputs

- `<opportunity-id>` — required positional argument. Must exist in the pipeline store; `npm run pipeline -- get <opportunity-id>` returns the row or exits non-zero.

## Sequence

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

### 1. Load + verify opportunity

Read the opportunity with `npm run pipeline -- get <opportunity-id>`, which prints the single row as JSON with the description included. Required fields:
- `id`, `url`, `title`, `company`, `description` (the JD)
- `classification.matched_resume_id` — which resume this opportunity matches
- `classification.requires_tailoring` (bool) — whether to take the tailor path
- `classification.profile_relevance` (number 0-100) — gate for tailoring

If classification is missing or `classification._classifier != "agent"` → halt and surface: "Opportunity not classified by the agent — run `/hunt` / opportunity-finder re-classification, then `npm run pipeline:rescore -- --classifications state/pipeline/classifications.json`; don't apply from regex/default scoring."

Before assembling a package, validate the loaded opportunity using `assertAgentClassificationForApplication()` from `tools/classification-policy.ts` or perform the same inline checks: persisted agent classification, non-null `matched_resume_id`, and no regex/default source.

If status isn't `awaiting_approval` or `approved`: ask via `AskUserQuestion`: "Currently in `<status>` — proceed anyway / move to awaiting_approval first / cancel?"

### 2. Decide CV path (baseline vs tailor)

Default = baseline. Take the tailor path ONLY when ALL of:
- `classification.requires_tailoring` is true
- `classification.profile_relevance` ≥ 80 (top decile)
- The opportunity isn't flagged `no_tailor: true`

### 2a. Keyword cloud is current (tailored path only, mandatory)

Market narrative comes first. Before any tailored composition, confirm the positioning's keyword cloud is current:

```
npm run resume:context -- --resume <resume-id> [--profile <profile-id>]
```

Read the brief's `clouds` block. If `missing: true` (no clouds referenced) or `stale: true` (a load-bearing cloud, weight >= 4, older than `stale_after_days` or with no readable `refreshed_at`), **do not render**. Run the `/resume-strategy` cloud refresh (steps 3b + 3c) for the named cloud now, in this session, then re-run the command and continue to 2b. The JD is the selection signal for this one application; the keyword clouds are the standing market vocabulary for the positioning, and the tailored CV needs both.

Baseline path skips this (nothing is composed here). Unattended runs never do it — see "When the daily orchestrator runs apply".

### 2b. Keyword plan + confirmations

The screener reads the JD's vocabulary, not yours. This step reconciles the JD's terms against the real corpus and, where the corpus is silent but the fact plausibly exists, asks the user rather than dropping the term or faking it. The JD dictates spelling and placement; it never creates facts.

Run this on the **tailor path always**. On the **baseline path, run it only when `classification.profile_relevance` ≥ 80, and report-only** — no baseline is re-composed here, so the plan just reports coverage and banks answers for the next `/resume-render`.

1. Write the JD snapshot to `state/pipeline/archive/<opportunity-id>/jd.md` first (step 5 needs it anyway; WebFetch the URL if `description` is truncated), then:

   ```
   npm run resume:keywords -- --resume <resume-id> --jd state/pipeline/archive/<opportunity-id>/jd.md --opportunity <opportunity-id>
   ```

   The plan lands at `state/pipeline/archive/<opportunity-id>/keyword-plan.json`.

2. If `questions` is empty, skip to step 5 of this sub-sequence. Otherwise ask them via `AskUserQuestion` in batches of **at most 4**, highest-value first (must-have terms before nice-to-have). The four reusable options are exactly:
   - `Confirm and update source (Recommended)`
   - `Bring in as familiarity` — the user did not deliver it but can credibly prepare and speak to it; recorded as `--status familiarity`, it renders once in a familiarity-framed skills line and is listed under `interview_prep_terms`, never as delivered work
   - `Not applicable`
   - `Unsure / keep pending`

   Question text = the plan's `question` plus its `evidence_hint` (the roles where the term plausibly occurred), so the answer is a yes/no plus optional detail. Never ask an open-ended "tell me about X". Dedupe questions sharing an `alias_group` — ask the group once, in the JD's spelling.

3. Record every answer deterministically — never hand-edit the ledger:

   ```
   npm run resume:keyword-confirm -- record --plan state/pipeline/archive/<opportunity-id>/keyword-plan.json \
     --term "<term>" --status confirmed|not_applicable|familiarity|pending --opportunity <opportunity-id> --origin attended
   ```

4. For each `Confirm and update source`, show the proposed one-bullet `cv-source.md` patch (the plan's `proposed_phrasing`) at the role named in `evidence_hint`, and ask in batches of at most 4: `Apply this wording (Recommended)` / `Edit wording` / `Skip`.
   - **Apply / Edit** → `npm run resume:keyword-confirm -- apply-patch --term "<term>" --resume <resume-id> --role-heading "<cv-source heading substring>" --bullet "<final text>"` (add `--skills` when the fact belongs in the Skills section). It inserts the bullet, prints the unified diff it applied, refuses a duplicate, and clears `source_update_required`.
   - **Skip** → the row stays `confirmed` with `source_update_required: true`. The term is still unrenderable; say so.
   - Remind the user the master `.docx` must carry the same fact or `/refresh-cv` drops it on the next re-parse.

   `Bring in as familiarity` needs no patch: the term is one the user did not deliver but can credibly prepare and speak to, so the re-run plan marks it `preppable` with `render_as: "familiarity"` and resume-writer renders it once in a familiarity-framed skills line ("Familiar with ...", "Working knowledge of ...", "Prepared on ..."), listing it under `interview_prep_terms`. It is answered, so it is never re-asked.

5. Re-run the same `resume:keywords` command so the plan reflects the patched corpus.

6. **Tailor path**: pass `--keyword-plan state/pipeline/archive/<opportunity-id>/keyword-plan.json` in the resume-writer prompt in step 3, and tell it the plan is a surfacing contract (every grounded / alias-grounded / confirmed term appears at least once, in the JD's spelling). **Baseline path**: don't re-render here — report the coverage numbers in step 6 and leave the answers for `/resume-render`.

Never ask these questions from an unattended run. See "When the daily orchestrator runs apply" below.

### 3. Spawn the artefact-writer subagents in parallel

This is the key step — spawn BOTH subagents in **one message** with **multiple Agent tool calls** so they run concurrently.

**Always spawn**: `cover-letter-writer` (every application needs its own letter).

```
Agent(subagent_type: "cover-letter-writer",
      description: "Cover letter for <opp-id>",
      prompt: "Compose cover letter for opportunity <opp-id>. ...")
```

**Conditionally spawn**: `resume-writer` — only on the tailor path:

```
Agent(subagent_type: "resume-writer",
      description: "Tailored resume for <opp-id>",
      prompt: "Compose tailored resume for <resume-id> with --tailor against JD at <jd-path>, --keyword-plan <plan-path>. Output dir: state/pipeline/archive/<opportunity-id>/. Seed from the approved baseline's *.composition.json, *.provenance.json sidecar and bench in state/profile/resumes/<resume-id>/; change summary emphasis, headline, evidence order, the screener block and a bounded set of bullets, not unchanged sections. Iterate through `npm run resume:audit --auto-fit` only and return your standard JSON quality report.")
```

On the baseline path: skip resume-writer. Verify the resume's baseline exists + is approved via `npm run resume:approve -- --check <resume-id>`:
- Exit 0 (approved) → use the baseline from `state/profile/resumes/<resume-id>/`.
- Exit 1 (stale) → ask: "Baseline drifted since approval — re-run /resume-render before apply? (recommended) / proceed with stale baseline / cancel?"
- Exit 2 (fresh/missing) → halt: "No approved baseline for `<resume-id>` — run /resume-render first."

### 4. Collect quality reports

Both subagents return JSON quality reports. Apply `.claude/skills/resume-render/references/enforce-quality-report.md` to each — every declared check id must have a verdict. Missing → reject the report and re-invoke the subagent with explicit "include all checks" instruction.

**Independently re-run the deterministic gates — do NOT trust the writer's prose verdicts.** The writer has historically narrated a tool `fail` down to "warn (acceptable)". So on the tailor path, re-run against the composition the writer produced:

```
npm run resume:audit -- --resume <resume-id> --content-json <archive>/*.composition.json --out-dir <archive> --strict-line-units true --jd <archive>/jd.md --keyword-plan <archive>/keyword-plan.json
npm run resume:keywords -- --resume <resume-id> --jd <archive>/jd.md --opportunity <opportunity-id> --composition <composition.json>
npm run resume:term-grounding -- --content-json <composition.json> --jd <archive>/jd.md --keyword-plan <archive>/keyword-plan.json
```

`resume:audit` exits 2 on any evaluate `fail` (ragged units, orphans, page budget) and carries provenance, ATS and term-grounding verdicts in `gates`; `resume:keywords --composition` exits 1 when coverage warns; `resume:term-grounding --keyword-plan` fails any term the plan did not authorise. If any exits non-zero with a `fail`-severity issue the report labelled pass/warn, treat the report as untrustworthy: re-invoke resume-writer naming the specific failing terms, or surface to the user. A green prose report over a red tool exit is a hard stop.

**On the tailor path, run the independent content review too**, once the gates above are green:

```
Skill(skill: "resume-critique", args: "<resume-id> --rounds 2")
```

Point it at the tailored composition in `state/pipeline/archive/<opportunity-id>/` rather than the baseline dir, since that is the artefact being sent. A tailored CV is exactly where duplicate bullets, a contradicted number and a rule-breaking framing appear, because the writer re-angled prose against a JD. A `block` verdict stops this application: surface the findings and do not bundle. A `revise` verdict at the round cap bundles with the open findings named in step 7's confirmation.

The baseline path skips this: the baseline was already critiqued and approved by `/resume-render` or `/resume-review`, and `npm run resume:approve` refused it otherwise.

### 5. Bundle the package

Create `state/pipeline/archive/<opportunity-id>/` and place:
- Resume: copy baseline (glob `state/profile/resumes/<resume-id>/*.docx` / `*.pdf` — filenames follow `{Profile-Name}_{Resume-Label}.ext`, e.g. `Jane-Citizen_Solution-Architect.pdf`; don't assume a literal name) OR tailored artefacts (from resume-writer's output).
- Cover letter: from cover-letter-writer's output (`cover-letter.md`).
- JD snapshot: write the JD text to `jd.md` (WebFetch the URL if the opportunity's `description` is truncated).
- `keyword-plan.json`: the final (post-patch, post-composition) keyword plan from step 2b.
- `metadata.json`: bundle of resume reference + cover letter reference + classifier verdict + both quality reports + keyword coverage (`renderable_pct`, `surfaced_pct`) + the count of pending `kind: keyword` rows + timestamp.

### 6. Show + confirm

Surface to user:
- Both quality reports (1-line summaries).
- Cover letter full text (it's short).
- Resume path + page count + ATS lint verdict.
- Any `human_review_needed: true` flags from either subagent.
- Keyword coverage from the plan: `surfaced_pct` / `renderable_pct` of must-have terms, any must-have terms left unsurfaced, and the count of keyword questions still `pending` (they will be offered again in `/review-drafts` or `/resume-review`).

Ask via `AskUserQuestion`: "Submit now (recommended if everything green) / let me eyeball the PDF first / cancel?"

### 7. Submit (only on user confirmation)

Check the channel's `auto_submit` in `state/profile/submission-policy.yaml`:
- `true` → spawn `submission-runner` subagent for this channel; it walks the channel-specific submit flow (Quick Apply / Easy Apply / recruiter email Gmail draft / portal form). Pauses on unknown screening questions; resumes after user answers.
- `false` → route to `/manual-applications` mode: open the URL in browser, copy the pre-filled text from the bundle, mark done when the user confirms back.

### 8. Record + sync

On success: transition status `→ submitted`. Record confirmation reference + screenshot (if captured) in `archive/<opportunity-id>/`. Mirror to Sheet via `state-syncer`.

## When to ask vs decide silently

- **Ask** about: proceed with non-approved status; stale baseline (re-render or proceed?); rate decisions when rate is unstated; unknown screening Qs; step 2a's cloud refresh when a keyword cloud is missing or stale; step 2b keyword confirmations and the cv-source patch wording.
- **Decide silently**: baseline vs tailor path (deterministic from classification); which resume to use (deterministic from `matched_resume_id`); how to bundle the archive (always the same layout); any keyword the ledger already answers (`confirmed`, `declined`, `not_applicable`) — the plan resolves those without a question, so never re-ask.

## Boundaries

- **Never submit without an explicit "Submit now" confirmation in this run**, even if the row is already `approved` in pipeline state.
- **Never bypass the validation gate** (lint, slop, voice, rate, ATS).
- **Never use a separate package-drafter subagent** — package assembly belongs to this skill-level orchestration. The orchestrator IS the skill.
- **Never edit canonical content** (experiences, summaries, banlist, voice-rules) from inside the apply flow. If a quality issue traces to content, surface; route to `/onboarding`, `/resume-strategy`, `/refresh-cv`, or direct file editing.
- **Never auto-send recruiter email**. A recruiter or hiring-manager email is always a draft saved in the opportunity's archive directory for the user to send themselves; there is no recruiter-email submit adapter.

## When the daily orchestrator runs apply

The daily run reuses the package-assembly and validation portions of this skill,
then splits by channel. For an autopilot channel (SEEK Quick Apply, LinkedIn Easy
Apply) an unattended run submits through `npm run autopilot:submit` once the
machine gates pass; it never runs Sections 6–8 or `submission-runner` to do it.
For every other channel it stops at a complete prepared package in
`manual_action_needed`, because Sections 6–8 as a submission flow require a fresh
attended confirmation for the exact application.

Step 2a is not skipped, it is enforced the other way: an unattended run never renders a positioning whose `clouds.missing` is true. Journal it, queue the refresh for the next attended session, and leave the opportunity in the prepared queue without a tailored CV.

Step 2b also changes shape: the run cannot ask, so it must not ask. Instead:

```
npm run resume:keywords -- --resume <resume-id> --jd <archive>/jd.md --opportunity <opportunity-id>
npm run resume:keyword-confirm -- queue --plan <archive>/keyword-plan.json --origin daily
```

`queue` records every plan question as `pending, origin: daily` without asking, and never reopens a row the user already answered. Render **without** those terms — a pending row authorises nothing. Write `keyword_coverage` (`renderable_pct`, `surfaced_pct`) and the pending count into `archive/<opportunity-id>/metadata.json`, and add a tray note when must-have renderable coverage is below 60%.
