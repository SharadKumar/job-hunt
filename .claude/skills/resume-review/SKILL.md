---
name: resume-review
description: Walk the user through reviewing and approving baseline CVs for every active resume. Use this skill whenever the user says "review my CVs", "approve my baselines", "are my CVs ready", "let me check the baselines", or before any first /apply on a resume. Also use after /onboarding populates new resumes (no baselines yet), after CV/source edits (existing approvals go stale), after positioning edits in resumes.yaml, or when the /apply orchestration reports a stale or missing baseline. This skill invokes resume-writer per resume — it never bypasses resume-writer to render baselines directly (which would skip quality auditing).
---

# /resume-review — per-positioning baseline review + approval

Each active resume gets one approved baseline CV — the version that gets sent across many opportunities matching that positioning. This skill keeps all baselines current and explicitly approved.

**Quality checks**: resume-writer (invoked per resume by this skill) applies the universal CV quality checks at `.claude/skills/resume-render/references/quality-checks.md` plus any per-template overrides. Same contract; same checks; consistent across all resumes.

The pattern is:

```
for each active resume:
   resume-writer subagent renders + audits  →  user reviews docx/pdf  →  approve or edit
```

## When this runs

- **First time after `/onboarding`** populates resumes — no baselines exist yet.
- **After a new experience, CV-source edit, or positioning edit** — existing approvals invalidate because content hashes drift.
- **Before first `/apply` on a resume** — the /apply orchestration blocks on unapproved baselines.
- **Periodic re-review** (monthly during active hunt) — sanity check that nothing's drifted unnoticed.

## Sequence

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

If one or more resumes have `market_alignment.confirmation_needed` or `market_alignment.open_questions`, prefer running this review in a mode exposing structured questions. If the current mode cannot show structured questions, do not ask gaps inline; pause and tell the user to rerun the judgement step in structured-question mode.

### 0. Drain pending keyword confirmations

Baselines render from `cv-source.md`, so unanswered keyword questions are the cheapest quality win available before any render. Start here:

```
npm run resume:keyword-confirm -- pending --group-by term
```

That groups outstanding `kind: keyword` rows by term across resumes and opportunities (queued by unattended `/daily` runs and by earlier "Unsure / keep pending" answers), busiest term first. If the count is 0, say so and go to step 1.

Otherwise drain them in batches of **at most 4** per `AskUserQuestion`, highest `count` first, with exactly these four reusable options:
- `Confirm and update source (Recommended)`
- `Bring in as familiarity` — the user did not deliver it but can credibly prepare and speak to it; recorded as `--status familiarity`, it renders once in a familiarity-framed skills line and is listed under `interview_prep_terms`, never as delivered work
- `Not applicable`
- `Unsure / keep pending`

Question text = the row's `question` plus its `evidence_hint`. One question per term even when several opportunities queued it. Then, per answer:
- Record it: `npm run resume:keyword-confirm -- record --plan <plan-path> --term "<term>" --status confirmed|not_applicable|familiarity|pending --origin attended` (use the plan the row came from, or regenerate one with `npm run resume:keywords -- --resume <id> --proactive`).
- On `Confirm and update source`, show the proposed bullet and ask `Apply this wording (Recommended)` / `Edit wording` / `Skip`, then `npm run resume:keyword-confirm -- apply-patch --term "<term>" --resume <id> --role-heading "<heading substring>" --bullet "<final text>"` (add `--skills` for a Skills-section fact). It prints the diff it applied. Remind the user the master `.docx` must carry the same fact.
- `Bring in as familiarity` records `--status familiarity`: a term the user did not deliver but can credibly prepare and speak to. No source patch. The re-run plan marks it `preppable` with `render_as: "familiarity"`, so resume-writer renders it once in a familiarity-framed skills line ("Familiar with ...", "Working knowledge of ...", "Prepared on ...") and lists it under `interview_prep_terms`. It is answered, so it is never re-asked.
- A confirmed term that was never patched stays unrenderable; do not treat the ledger row as permission.

Any resume whose `cv-source.md` changed here is now stale — expect it in the `STALE` bucket in step 1 and re-render it.

### 1. Status snapshot

Run: `npm run resume:approve -- --status`

Returns a list per resume with `{id, status, approved_at, content_hash, approved_hash}` where status ∈ {`approved`, `stale`, `fresh`, `missing`}.

Group by status and surface to the user:

```
APPROVED (N):
  enterprise-architect-transformation   approved 2026-05-27
  fractional-chief-architect            approved 2026-05-27
STALE (M):  (content drifted since last approval)
  ai-product-vctolead                   stale    last approved 2026-05-20
FRESH (K):  (rendered but never approved)
  outcomes-based-delivery-partner       fresh    rendered 2026-05-26
MISSING (L): (no baseline rendered yet)
  servicenow-salesforce-architect       missing
```

### 1.4 Keyword cloud is current (mandatory, per resume)

Market narrative comes first: no positioning is rendered against a stale or absent keyword cloud. For every resume that step 1 put in `missing`, `fresh` or `stale` — i.e. every resume this run might re-render — run:

```
npm run resume:context -- --resume <resume-id> [--profile <profile-id>]
```

Read the brief's `clouds` block (`present`, `missing`, `stale`, `term_count`, `unknown_cloud_ids`, and a `clouds[]` row per referenced cloud with its `id`, `label`, `weight`, `refreshed_at`, `age_days` and `stale`):

- `missing: true` (the positioning references no clouds), or `stale: true` (a load-bearing cloud, weight >= 4, older than `stale_after_days` or with no readable `refreshed_at`) → **do not render that resume**. Run the `/resume-strategy` cloud refresh (steps 3b + 3c) for the named cloud now, in this session, then re-run the command. Only then continue. A cloud is shared, so one refresh may clear the gate for several resumes in this batch at once — do them together rather than one per resume.
- `unknown_cloud_ids` non-empty → fix the reference (or create the cloud) before rendering.
- Otherwise report the cloud count, total term count and the heaviest cloud's refresh date in the status line for that resume.

The refresh ends in the evidence interview (`/resume-strategy` step 3c), which must offer all four reusable answers: `Confirm and update source`, `Bring in as familiarity`, `Not applicable`, `Unsure / keep pending`. Unmatched but important terms are put to the user, never silently dropped.

`npm run resume:audit` enforces the same rule as `gates.clouds` (fail when the positioning references none, warn when a load-bearing cloud is stale), so skipping this only moves the stop later and wastes a render.

### 2. Render any missing baselines via resume-writer

For each resume with status `missing` (no per-resume render yet), invoke the **resume-writer subagent** (mode: baseline). When there are multiple missing baselines (3 or more), spawn resume-writer subagents in parallel — each in its own context window — by sending multiple Agent tool calls in one message.

For team profiles, resolve paths under `state/profiles/<profile-id>/`; default individual mode remains `state/profile/`.

The pattern (one Agent tool call per resume):
```
Agent(subagent_type: "resume-writer",
      description: "Render baseline for <resume-id>",
      prompt: "Render baseline CV for resume <resume-id>. Output dir: <profile-dir>/resumes/<resume-id>/. Flavours: ats,presentation. Max-pages: 3. Keyword plan: <profile-dir>/resumes/<resume-id>/keyword-plan.json (surfacing contract; run `npm run resume:keywords -- --resume <resume-id> --proactive` first if it is missing). Seed from the existing *.composition.json and *.provenance.json sidecar when present. Compose a bench, write provenance to the sidecar, iterate through `npm run resume:audit --auto-fit` only, and return your standard JSON quality report.")
```

Before spawning, generate the proactive keyword plan per resume (`npm run resume:keywords -- --resume <id> --proactive`). Questions it raises were drained in step 0; do not ask them again here.

**Critical**: do NOT call deterministic render commands directly from here. `npm run resume:render:raw` only materialises already-composed JSON; it does not perform judgement, visual review, or the quality report. Using it would leave you with files but no contract about fitness to send.

Collect each resume-writer's quality report.

### 3. Walk each resume needing attention

For every resume whose status is `missing`, `fresh`, or `stale` — and after resume-writer has produced a fresh render where needed:

0. Enforce the profile's `render_efficiency` budget. A writer that reaches `hard_stop_minutes` must return its current artefacts and a complete flagged report; do not leave batch review waiting on an open-ended subagent loop. Check the report's `audit.cycles` against `max_full_render_iterations`; more cycles than allowed means the writer ignored its budget, so mark `human_review_needed: true` and note it.

1. **Surface what's there**:
   - `missing` → "First time rendering for `<resume.label>`. Here's the proposed baseline:"
   - `fresh` → "Rendered but never approved. Here's the baseline waiting for sign-off:"
   - `stale` → "Content has drifted since approval. Show the diff between `cv.md` (current) and `approved-cv.md` (snapshot from last approval) — focus on bullets added/removed, summary changes."

2. **Enforce report completeness** for each resume-writer report (apply `.claude/skills/resume-render/references/enforce-quality-report.md`): every declared check id (universal + per-template) must appear with a verdict. Missing → reject + re-invoke or surface hard error. Also require `artefacts.composition_json`, `artefacts.provenance_json` and `checks.structural.source_provenance`; missing or failed provenance blocks approval because the CV cannot be traced back to source.

   **Independently re-run the deterministic gates; never trust prose verdicts.** Against the composition the writer left in the resume dir:
   ```
   npm run resume:audit -- --resume <id> --content-json <profile-dir>/resumes/<id>/*.composition.json --out-dir <profile-dir>/resumes/<id> --strict-line-units true --keyword-plan <profile-dir>/resumes/<id>/keyword-plan.json [--profile <p>]
   npm run resume:keywords -- --resume <id> --proactive --composition <composition.json>
   npm run resume:term-grounding -- --content-json <composition.json> --keyword-plan <plan-path>
   ```
   A non-zero exit with a `fail`-severity issue the report labelled pass/warn makes the report untrustworthy: re-invoke resume-writer for that resume naming the failing units or terms, or surface to the user. A green prose report over a red tool exit is a hard stop. Then surface the complete report (structural + visual + provenance + keyword coverage), with `human_review_needed: true` cases highlighted prominently.
   - If `market_alignment.confirmation_needed` exists, surface those as targeted judgement questions. The user can answer them now, but confirmed facts must update `<profile-dir>/market-confirmations.yaml` and then `<profile-dir>/cv-source.md` before re-rendering; do not add them directly to rendered prose.
   - If `market_alignment.open_questions` exists, surface those as source-completion questions. They may not block approval, but they identify marketable gaps worth confirming for future renders.
   - If `source_update_required` exists, do not ask again. Tell the user the fact was already confirmed and still needs to be added to `cv-source.md`.
   - If `suppressed_confirmations` exists, keep those claims out by default because the user previously declined or marked them not applicable.

2.5. **Independent content review** — invoke the critique skill per resume, after the gates in step 2 pass and before any approval is offered:

   ```
   Skill(skill: "resume-critique", args: "<resume-id> --rounds 2 [--profile <profile-id>]")
   ```

   It owns the whole loop: spawn resume-critic, persist `<prefix>.critic.json`, then one `npm run resume:edit -- --resume <id> --edits <findings-or-edits>.json` that applies the findings, re-anchors provenance and re-audits in a single process, re-run the critic once, stamp `metadata.json`, append any finding that has now recurred across two or more resumes to `<profile-dir>/resume-editorial-rules.md`. Do not spawn resume-critic directly from here and do not re-implement the rounds.

   Run it one resume at a time even when step 2 rendered several in parallel: each critique round ends in a deterministic apply-and-re-audit against that resume's composition, and the learned-rules pass reads every sibling review. That apply step is the only way the composition may change — never hand-edit `<prefix>.composition.json` or its provenance sidecar.

   - `pass` → offer approval in step 4.
   - `revise` at the round cap → offer approval only with the open findings named in the question text, and mark `human_review_needed: true`.
   - `block` → approval is not offered for this resume. Surface the findings, leave the status as-is, and move to the next resume.

3. **Open the artefacts** for the user:
   ```
   open <profile-dir>/resumes/<id>/{Profile-Name}_{Resume-Label}.docx
   open <profile-dir>/resumes/<id>/{Profile-Name}_{Resume-Label}.pdf
   ```
   They eyeball.

4. **Ask via the active CLI's structured question tool**: "Approve this baseline / Edit before approving / Skip for now / Re-render with different template"
   - Claude Code: use `AskUserQuestion`.
   - Codex: use `request_user_input` when available.
   - For `market_alignment.confirmation_needed` and `market_alignment.open_questions`, ask with choices like "Confirm and update source", "Not applicable", "Bring in as familiarity", and "Unsure / keep pending"; do not render them only as inline text when a structured tool is available.
   - **Approve** → `npm run resume:approve -- --resume <id>`. Snapshots `cv.md` → `approved-cv.md` for future diffs.
   - **Edit before approving** → apply `.claude/skills/resume-render/references/capture-editorial-edits.md`:
     - Ask "What changed?" with structured options (bullet removed / experience demoted / phrasing changed / summary edited / multiple).
     - Append the entry to `state/profile/resumes/<resume-id>/editorial-rules.md`.
     - Re-invoke resume-writer for THIS resume only (not the whole batch); loop back to step 3.
     - On threshold crossing (same pattern twice in 7 days): surface promotion-to-global per the procedure.
   - **Answer confirmation/open questions** → update `<profile-dir>/market-confirmations.yaml`; if confirmed, update the canonical source first, then re-render this resume only; loop back to step 3.
   - **Skip** → leave status as-is. Note that the drafter will warn when this resume gets matched.
   - **Re-render with different template** → re-invoke resume-writer with the new template name; loop back to step 3.

### 4. Final summary

Tally counts: `N approved / M stale / K fresh / L skipped`. If anything is non-approved, surface: "These resumes won't auto-draft via /apply or /daily until approved. The /apply orchestration blocks on unapproved baselines (warning + halt by default; controllable via `submission-policy.yaml: require_template_approval`)."

## Why Per-Resume Subagent

Deterministic render utilities are low-level plumbing only. They:
- Materialise composed JSON, but do not choose evidence or re-author content.
- Do not run the multimodal visual review or template-quality report.
- Provide nothing actionable to the user about why a CV looks the way it does or what might need attention.

resume-writer (the subagent), invoked per resume, produces auditable artefacts AND a structured report that drives this skill's approve/edit/skip decision tree. That's the whole point of the architecture — every CV that lands in `state/profile/resumes/<id>/` should have been audited by resume-writer, not just dumped there by a script.

## Boundaries

- **Never auto-approve.** Approval requires explicit user "Approve" per resume.
- **Never offer approval before the critique skill returns a pass** for that resume. `npm run resume:approve` refuses a missing, blocking or stale critic verdict anyway, so skipping the step only produces an error the user has to decode.
- **Never edit canonical content from inside this skill.** CV-source content and resume positioning fields are profile changes that route to `/onboarding`, `/resume-strategy`, `/refresh-cv`, or direct file editing. This skill triggers re-renders after such changes; it doesn't make them itself.
- **The approval flow gates drafting, not hunting.** Hunts still run, opportunities still classify and score; only the /apply draft orchestration consults baseline approval status.
- **No bypassing resume-writer.** Always route through the subagent for renders — even for a quick "let me see what changed". The cost is small; the contract value is large.

## When to ask vs decide silently

- **Ask**: pending keyword confirmations in step 0 (batched, at most 4); approve / edit / skip / re-render per resume. What to do with a `block` verdict from the critique skill. What to edit when user picks "edit". Whether to re-render with a different template.
- **Decide silently**: order to walk resumes (alphabetical, or by status: missing > stale > fresh), rendering parameters (max-bullets default 7, flavours both), file paths, hash format.
