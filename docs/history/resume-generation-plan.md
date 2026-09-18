# Resume Generation Plan

> **Historical planning document (May/June 2026). Superseded by AGENTS.md section 5 and README. Kept for context.**

## Purpose

Create excellent, reusable resume outputs from a person's canonical CV evidence and resume market positionings.

The harness should not pre-generate final resume content independent of template constraints. AI judgement should compose the resume at render time from the CV corpus, resume brief, selected template, and optional JD context. Deterministic code should handle rendering, validation, hashing, conversion, and audit checks only.

## Implementation Status

Implemented on 2026-05-28 and realigned to the current renderer/template architecture on 2026-06-01:

- Named the first-run flow `onboarding`.
- Added `resume-strategy` for later strategy changes.
- Fixed production rendering guardrails so production paths require AI-composed `--content-json`.
- Migrated resume composition to the holistic `state/profile/cv-source.md` source.
- Updated approval status so existing rendered baselines are seen as fresh rather than missing.
- Current profile-facing reusable templates are `classic`, `modern`, and `minimalist`. The older 2026-05-28 template names are archived under `templates/resume/_archived_20260528/` and are not part of the active set.
- Added profile-neutral golden resumes for each profile-facing template, rendered from `tests/fixtures/resume-content/senior-operator.json`.
- Added a resume research pack in `docs/resume-research/claims.yaml`, per-template `rubric.yaml` files, and `npm run resume:evaluate` to enforce the deterministic parts of the rubrics.
- Moved visible heading policy into templates/rubrics. Renderers choose from each template's `allowed_headings`; resume-writer composes semantic content only.
- Presentation output now uses the HTML/CSS plus Playwright PDF path for the active templates, while ATS output uses a shared plain `.docx` renderer.
- Current samples use `templates/resume/<template>/sample/sample-content.json` plus `golden.md`, `golden.html`, `golden.docx`, `golden.pdf`, and `golden-page-*.png`.
- Updated verifier coverage for the new skills, templates, production render guard, sample artefacts, sample page budgets, stored rubric checks, and fresh render/evaluate sample checks.

The current active profile uses `classic`, `modern`, and `minimalist` across its six active resume positionings.

## Naming Decisions

- `onboarding`: one-time first-run career intake. Reads the person's CV, career history, skills, and evidence; identifies viable resume positionings; writes `state/profile/resumes.yaml`; assigns default templates; then routes to baseline review.
- `resume-strategy`: later review of the market positionings in `resumes.yaml`. Use when strategy changes, the market shifts, or the person wants to add/remove/reshape a resume positioning.
- `resume-review`: review and approve rendered baseline resume artefacts. This is about the generated documents, not the strategy.

The old first-run name has been replaced by `onboarding`. The harness fixes forward rather than maintaining legacy aliases.

## Core Model

- `state/profile/cv-source.md` is the canonical evidence bank: the full master CV parsed into holistic markdown.
- `state/profile/cv/meta.yaml` records source-file and parse metadata; the old atomic CV split is archived under `state/profile/cv/_archive_atomic_20260528/`.
- `state/profile/resumes.yaml` is profile-specific strategy: which resume positionings are credible for this person and how the harness hunts, matches, and pitches each one.
- `templates/resume/` is reusable harness-level presentation logic. Templates must be usable by any profile and must not contain profile-specific content.
- `docs/resume-research/claims.yaml` is the research memory: dated source-backed claims the harness treats as policy.
- `templates/resume/<name>/rubric.yaml` maps those claims to template-specific rules: safe headings, section order, page budget, density, and evidence thresholds.
- `resume-writer` is the editorial AI layer. It selects, trims, rewrites within evidence constraints, and composes `ResumeContent`.
- `ResumeContent.source_provenance` is the audit trail from authored content back to `state/profile/cv-source.md` and `state/profile/profile.md`; it is not rendered, but it is persisted and validated.
- Renderers are printers. They materialise the AI-composed `ResumeContent`, choose allowed visible headings from the rubric, and must not decide what belongs in the resume.

## Resume Flow

1. Onboarding
   - Load the full CV/career/skills corpus.
   - Use AI judgement to identify 3-6 credible resume positionings.
   - Write `resumes.yaml` with resume briefs: id, label, search keywords, should/could/flagged signals, evidence hooks, rate band, preferred channels, and default template.
   - Tag bullets as evidence signals for those positionings.
   - Do not write final resume content as if one template-independent version will be optimal.

2. Baseline resume generation
   - `resume-writer` reads the full raw corpus plus one `resumes.yaml` resume.
   - It selects featured experiences, mention-only experiences, dropped experiences, bullets, skills, highlights, and summary copy.
   - It composes content specifically for the selected template's constraints: page budget, density, section order, safe headings, evidence thresholds, and visual rhythm.
   - It passes `--content-json` to the renderer.
   - Renderer produces docx/pdf/md.
   - Structural, research-rubric, ATS, and visual checks run.
   - User reviews and explicitly approves the baseline.

3. Application generation
   - Default path uses the approved baseline resume for the matched positioning.
   - Tailoring is exceptional: only high-fit opportunities where the JD needs evidence the baseline does not surface.
   - Cover letters remain per-opportunity.

## Reusable Template Set

Maintain two or three generic templates:

- `classic`: executive editorial template for senior enterprise, consulting, government, and architecture audiences. Conservative, serif-led presentation PDF with a 3-page hard budget.
- `modern`: contemporary operator template for AI/product/startup/fractional CTO style roles. Stronger hierarchy, Inter typography, restrained accenting, 2-page target with 3-page allowance.
- `minimalist`: bare-typography template for design-aware companies, agencies, founder-network advisory, and fractional-CTO use. Tight 2-page hard budget.

Archived low-level and legacy templates remain under `templates/resume/_archived_20260528/` for reference only. Profile strategy should prefer `classic`, `modern`, or `minimalist`.

## Research-Based Quality Loop

Research is applied in three layers:

1. `docs/resume-research/claims.yaml` stores source-backed claims with confidence, checked date, and implementation hook.
2. `templates/resume/<template>/rubric.yaml` translates those claims into template-specific constraints.
3. `npm run resume:evaluate` checks rendered output and composed `ResumeContent` against the rubric.

This keeps stable resume theory out of runtime prompt drift while still letting `resume-writer` use judgement for evidence selection, phrasing, ordering, and target adaptation.

Headings are intentionally template policy. `resume-writer` composes semantic sections; renderers choose safe visible labels. The current policy is:

- `classic`: `Professional Summary`, `Career Highlights`, `Core Skills`, `Professional Experience`, `Earlier Experience`, `Education`.
- `modern`: `Summary`, `Selected Impact`, `Skills`, `Experience`, `Earlier Experience`, `Earlier`, `Education`.
- `minimalist`: `Summary`, `Experience`, `Skills`, `Highlights`, `Earlier`, `Education`.

## Template Samples

Each profile-facing template has a reusable sample under `templates/resume/<template>/sample/`:

- `sample-content.json`: the neutral composed `ResumeContent` fixture copied into the template sample.
- `golden.md`: the shared composed content rendered as markdown.
- `golden.html`: the presentation HTML used for PDF rendering.
- `golden.docx`: ATS/Word artefact.
- `golden.pdf`: visual review artefact.
- `golden-page-*.png`: page images for quick inspection.

The samples are generated from `tests/fixtures/resume-content/senior-operator.json`, a synthetic profile unrelated to the active user. They are documentation of expected output quality, not production content. Current stored sample page counts are: `classic` 2 pages, `modern` 2 pages, `minimalist` 2 pages.

## Closed-Loop Contracts

1. Enforce AI composition for production.
   - The renderer accepts composed `ResumeContent` via `--content-json`.
   - Production output under `state/profile/resumes/**` or `state/pipeline/archive/**` must not use coarse deterministic corpus filtering.
   - `resume-writer` is the only production path because it composes, renders, evaluates, visually inspects, and iterates.

2. Maintain baseline metadata and approval.
   - Resume generation writes `metadata.json` beside each baseline.
   - Include content hash, template hash/version, composer report hash, approved hash, and approval status.

3. Prevent schema drift.
   - `resumes.yaml` uses `resumes:`.
   - `onboarding` writes `resumes:`, not stale target files.
   - Docs and tools treat `state/profile/resumes.yaml` as the source of truth.

4. Keep the writer contract explicit.
   - Template constraints, research claims, and `rubric.yaml` are explicit inputs to `resume-writer`.
   - `resume:evaluate` is the deterministic research-rubric gate.
   - `resume:provenance` is the deterministic source-coverage gate. It validates saved composition JSON, source hashes, line ranges, and unsupported-claim emptiness; resume-writer still owns semantic judgement that the cited lines actually support the rewritten claim.
   - Save the composed `ResumeContent` JSON, composition report, and quality report with the artefacts.
   - Capture per-resume editorial rules from user edits and feed them into future compositions.

5. Keep smoke tests active.
   - Production render without `--content-json` fails.
   - `onboarding` writes valid `resumes.yaml`.
   - `resume:approve --status` sees rendered baselines.
   - All active templates render a generic composed `ResumeContent`.
   - Production renders persist `<prefix>.composition.json`.
   - `resume:provenance` fails when production composition lacks `source_provenance`.
   - Stored template samples exist and stay within their page budgets.
   - Stored and freshly rendered samples pass `resume:evaluate`.
   - Template list utilities read from `templates/resume/`, not stale `templates/cv/`.

## Completed Migration Phases

1. Rename and schema cleanup
   - Skill directory and docs: first-run profile setup -> `onboarding`.
   - Script names: use `onboarding:*`.
   - Add `resume-strategy` skill for later strategy changes.

2. Production guard and metadata
   - Fix renderer production path detection.
   - Add baseline metadata write on writer-driven renders.
   - Fix approval command options.

3. Template contract
   - Add per-template composition constraints.
   - Keep the active reusable set at `classic`, `modern`, and `minimalist`.

4. Writer-first resume generation
   - Update `resume-writer` so every production run composes from raw corpus, resume brief, template constraints, and editorial rules.
   - Ensure deterministic loaders are preview-only.

5. Verification
   - Add regression tests for guardrails, metadata, approvals, and template availability.
   - Run `npm run verify:plan -- --plan <path>` after the migration (the `--plan` flag is required).
