---
name: onboarding
description: One-time career intake for a new profile. Reads the person's CV plus any supplementary URLs, proposes 3-6 credible resume positionings, confirms them with the user, and writes state/profile/resumes.yaml. Use for first setup after a fork or when resumes.yaml has no active entries. For later strategy changes, use resume-strategy instead.
---

# /onboarding — create the initial resume positionings

This is the first-run career intake. It turns a person's CV evidence into the initial `state/profile/resumes.yaml` strategy file.

It is intentionally agent-driven. There are no paid SDK calls. The agent does the judgement work using its own context; `tools/onboarding.ts` is deterministic glue for loading context and writing validated YAML.

## When This Runs

- First time after a fork, when `resumes.yaml` has no active entries.
- A deliberate re-onboarding after a major career reset.
- Not for ordinary tweaks. Use `/resume-strategy` for later changes to active resume positionings.

## Sequence

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

### 1. Check prerequisites

- `state/profile/cv-source.md` exists and contains ≥5 role headers under "Professional Experience".
- If not, prompt the user for their master CV path and run `npm run markdownify:cv -- --source <path-to-master-cv.docx>` to generate it.

### 2. Collect supplementary URLs

Ask via `AskUserQuestion`: "Public sites / products / portfolios I should consider when proposing resume positionings?"

Options: "No, just the CV" / "Yes, I'll list them".

### 3. Load context

Run:

```bash
tsx tools/onboarding.ts context --urls <comma-separated>
```

This returns the holistic CV (cv-source.md) plus URL text, rate anchors, work arrangement, red flags, and valid channel ids.

### 4. Analyse and propose resume positionings

Using agent judgement, propose 3-6 candidate resume positionings. Each candidate should include:

- `id` — kebab-case stable identifier.
- `label` — human-readable resume positioning.
- `rationale` — 1-2 sentences.
- `confidence` — high / medium / low.
- `evidence_from_cv` — 1-3 concrete experiences or outcomes from cv-source.md supporting it.

Guidance:

- Be specific. "Solution Architect" beats "Consultant".
- Include stretch positionings only when the CV or supplied URLs provide real evidence.
- Stable ids matter because downstream artefacts live under `state/profile/resumes/<id>/`.

For fast-moving domains, tools, or market labels named by the user or strongly implied by the CV, read `.claude/skills/resume-strategy/references/market-lens-discovery.md` and run a short market-discovery pass before finalising candidates. Examples: "Claude Code", "applied AI", "agent platforms", "AI engineering leadership".

- Research current employer language and capability expectations using primary or durable sources where possible. Build queries from the CV/resume combo, including evidenced platforms, tools, seniority, domain, and suspected gaps.
- Convert the research into a compact capability map: expected capabilities, market aliases, concrete source evidence patterns, proof questions, and forbidden claims.
- Compare the capability map to `cv-source.md`; classify signals as `explicit`, `implicit`, `needs_confirmation`, or `missing`.
- Use this to shape candidate positioning, but do not overfit first-run onboarding to speculative market language.

### 5. Confirm with the user

Surface the proposals and ask which to activate. For additions, gather label and brief description.

### 6. Draft each confirmed `resumes.yaml` entry

For each confirmed positioning, draft:

- `search_keywords`
- `should`
- `could`
- `flagged`
- `market_lens`, with `must_signal`, safe `keyword_aliases`, targeted `proof_questions`, and `forbidden_claims`
- `cover_letter_angle`, grounded in a specific CV achievement (this is the lead-hook resume-writer will compose the summary around)
- `evidence_strategy`, identifying which source evidence to magnify, support, or de-emphasise for employer value in this positioning
- `rate_band`, anchored to the profile's stated rate units
- `preferred_channels`, using only valid channel ids
- `template`, selected from `templates/resume/`
- `notes`

Critical grounding rules:

- Never invent experiences or evidence — every claim in `cover_letter_angle` and `should` must be traceable to cv-source.md.
- `market_lens` may describe what the market expects even when the CV is weak, but it must distinguish safe aliases from proof questions. `acceptable_if_source_mentions` must contain source-specific evidence patterns, not generic keywords. Do not turn proof questions into rendered claims.
- If a proof question is valuable but unanswered, add it to `market_lens.proof_questions`; do not ask broad "what else?" questions.
- When a user answers a proof question during onboarding, record the answer in `state/profile/market-confirmations.yaml`. Confirmed facts still must be added to `cv-source.md` before `resume-writer` can render them.
- Keep evidence weighting explicit. If a project is technically relevant but weak as employer proof (side project, old work, small scale), put it under `support` or `de_emphasize` rather than letting resume-writer over-feature it.
- Never invent rate units or channel ids.
- Do not pre-compose summaries here. `resume-writer` composes positioning-specific summaries at render time from `cover_letter_angle` + featured-experience evidence in cv-source.md.

Ask the user to accept, edit one field, regenerate, or skip each draft.

### 7. Write each resume positioning

For each confirmed positioning, run:

```bash
tsx tools/onboarding.ts write-resume --json '<json>'
```

The script validates required fields and appends/replaces the entry under `resumes:` in `state/profile/resumes.yaml`.

### 8. Verify and route next step

Run `npm run verify:plan`.

Then ask:

> "Resume positionings are active. To pick up the new grounding, I can rescore the existing pipeline, re-hunt all channels, or wait. Which?"

## Boundaries

- Do not overwrite a populated `resumes.yaml` without showing the diff and asking.
- Do not add more than 6 active positionings in one onboarding pass.
- Do not render or approve resumes here. Route to `/resume-review` after onboarding (which iterates `resume-writer` per positioning).
