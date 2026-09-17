# Job-Hunt Career Harness

A fork-friendly harness that runs a contractor's job hunt as a controlled loop: it scans chosen channels, classifies and scores roles against your positionings, composes CVs and cover letters in your voice under deterministic quality gates, submits one-click applications on the channels you put on autopilot, and hands everything else to you as a prepared package. Cross-CLI: works with **Claude Code** (primary) or **Codex CLI** (best-effort).

**Unattended sends happen only on the one-click autopilot channels (SEEK Quick Apply, LinkedIn Easy Apply), only when the machine gates pass, and only while `autopilot.enabled` is on and the kill switch is off. Everything else (external ATS portals, recruiter and hiring-manager messages, LinkedIn comments and DMs) stops at a draft or a prepared manual package and needs you present.**

New here? Jump to [Getting started](#getting-started-new-person) or [Developer onboarding](#developer-onboarding).

## What this is

- **Hunts** roles across Seek, LinkedIn (Jobs + hiring Posts), AU IT recruiters (Hays, Talenza, Paxus, Robert Half, Peoplebank), HN Who-is-hiring, Wellfound, and direct-to-company.
- **Scores** each role transparently against your profile (skills, seniority, rate, remote, red flags) — weights live in `state/profile/scoring-weights.yaml`, you tune them.
- **Drafts** an ATS-safe CV variant tailored to the role + a cover letter in your voice. Closed-loop fit-to-pages (default ≤ 3) and ATS lint gate the output.
- **Submits** on autopilot where a one-click adapter exists (SEEK Quick Apply, LinkedIn Easy Apply) once an independent letter-critic pass and the submission gate agree. A job you save on SEEK is an order to apply, regardless of score.
- **Queues** everything else in a Google Sheet `Tray` tab and the manual queue. You tick `approve` / `reject` / `edit` / `hold` per row on your phone; attended `/apply`, `/submit-approved` or `/manual-applications` finishes them with you present.
- **Tracks** the pipeline in `state/pipeline/pipeline.db`, mirrored to the Sheet.
- **Surfaces** a short brief whenever you open the project locally.

## Non-goals

- No unattended sends outside the one-click autopilot adapters. A Sheet `approve` on any non-autopilot channel authorises preparation only; external ATS portals and every other channel need you present for that exact package.
- No auto-sent recruiter email. Drafts only, saved in the opportunity's archive for you to send from your own client.
- No LinkedIn auto-comment / auto-DM. Drafts only; you send from your client.
- No two-way Sheet sync beyond the `Action` + `Edits` columns. The Sheet is otherwise a read-only mirror, and optional: `sheet.enabled: false` retires it in favour of the local UI.

## Architecture

### Vocabulary

These terms are used with exactly these meanings throughout the code, the skills and the agent prompts. If a sentence in this repo seems ambiguous, check it against this table first.

| Term | Meaning |
|---|---|
| **Profile** | The single human the harness serves. Lives at `state/profile/`. Identity, locale, voice rules, rate band, red flags. |
| **Experience** | A past work-history item inside the holistic source CV at `state/profile/cv-source.md`. Resume composition rewrites from this evidence and records provenance in the composed JSON. |
| **Skill** | A competency / tool / domain evidenced in `state/profile/cv-source.md`, with matching synonyms in `state/profile/skills-taxonomy.yaml`. |
| **Resume** | A go-to-market positioning the harness can hunt and pitch. `state/profile/resumes.yaml`. Each resume declares: label, search keywords, should/could/flagged signals, cover-letter angle, rate band, preferred channels, template name, and notes. |
| **Template** | A renderer plus rubric that produces a CV from canonical content. `templates/resume/<name>/render.ts` controls artefacts; `rubric.yaml` controls safe headings, page budget, density, and evidence thresholds. Harness-level; shared across profiles. Preferred examples: `classic`, `modern`, `minimalist`. |
| **Channel** | A source of opportunities (Seek, LinkedIn, Hays, HN, etc.). `tools/channels/<id>.ts`. Pluggable per the `HuntChannel` interface. |
| **Opportunity** | A specific job posting being tracked. Lives in the pipeline store `state/pipeline/pipeline.db`. Has a status (discovered → shortlisted → drafted → awaiting_approval → approved → submission_pending → submitted → responded → interview → offered → won). |
| **Application** | The CV + cover letter package submitted for one opportunity. Archived at `state/pipeline/archive/<opportunity-id>/`. |
| **Classification** | The agent's structured judgement about an opportunity: red flags, bonuses, matched_resume_id, profile_relevance, requires_tailoring. Schema at `npm run classify:schema`. |

### Conceptual flow

```
Profile  →  picks several  →  Resumes
                                  │
                                  ├─→  keywords (union)  →  Channels  →  Opportunities
                                  │                                          │
                                  └─→  CV variant + template + angle  ──────┴→  Application
                                                                                  │
                                  slop / voice / letter-critic gates  ───────────┘
                                                                                  │
                                              ┌───────────────────────────────────┴──────────────┐
                                              ↓                                                  ↓
                          one-click channel on autopilot                        every other channel / portal
                          (SEEK Quick Apply, LinkedIn Easy Apply)                                │
                                              │                                                  ↓
                                              ↓                                        Tray + manual queue
                              submission gate (tools/submission-gate.ts)                         │
                                              │                                                  ↓
                                              ↓                                   attended exact confirmation
                                   autopilot-submit → submitted                                  │
                                                                                                 ↓
                                                                                       submission-runner
```

### Key design choices (and why)

1. **Cross-CLI via skills** (`.claude/skills/<name>/SKILL.md`, mirrored to `.agents/skills/`). Both Claude Code and Codex CLI consume skills natively. Custom prompts/commands are deprecated in both. *Why:* one user-invokable surface, both auto-triggered (by description match) and explicit (`/<name>`).
2. **Reasoning runs in-agent, not via paid SDK.** The harness has no Anthropic API key. The agent (Claude Code or Codex CLI session) does classification, drafting, resume proposals using its own LLM context (your subscription). Tools provide deterministic utilities + schemas only. *Why:* no separate billing, no API setup; fork-friendly.
3. **Profile is the human, resumes are the positionings.** A profile has many resumes (most senior people are multi-positioned). Don't confuse a "desired role family" with a "played role" or an "opportunity". The vocabulary holds the line. Optional org mode can centralise resume types, but the default remains one profile with free-form resumes.
4. **`resumes.yaml` is the single source of truth** for what the harness hunts and drafts for. Channels derive search keywords from active resumes. Classifier grounds `matched_resume_id` in active resumes. Drafter routes to the matched resume's CV variant + cover-letter angle. *Why:* changing your positioning is a one-file edit; everything downstream adapts.
5. **Templates are renderers, not styles.** A template is code that takes canonical content and produces artefacts. Different templates can use entirely different rendering engines (HTML+CSS via Playwright Chromium, the `docx` library). Each profile-facing template carries a profile-neutral sample resume so "good output" is visible without using the active profile. *Why:* visual / layout / structural variation needs code; a docx-reference can only carry typography.
6. **Research becomes policy, not vibes.** Resume guidance is captured in `docs/resume-research/claims.yaml`, then applied per template in `rubric.yaml`, then checked with `npm run resume:evaluate`. *Why:* unknown unknowns should become harness constraints and regression tests, not remembered advice.
7. **Headings are template policy.** `resume-writer` composes semantic content; templates choose visible section labels from `rubric.yaml`. *Why:* headings affect ATS parsing and recruiter scan behaviour, so "creative" wording must be constrained.
8. **One template, many resumes** + **one CV per resume** (the baseline). Multiple resumes can share a template; each resume has its own approved baseline CV (content). *Why:* visual consistency is template-level; positioning is resume-level; both compose.
9. **Baseline-by-default, tailor-by-exception.** Each resume has an *approved baseline CV* the user has eyeballed once. 95% of applications use that baseline as-is, with only a per-opportunity cover letter. Tailoring fires only when (a) score ≥ 80 AND (b) the JD demands specifics the baseline doesn't surface AND (c) the user hasn't opted out. *Why:* a confident senior sends one CV to many similar roles; 500 mildly-tweaked drafts look bot-generated.
10. **Cover letter is always per-opportunity** (the JD-specific contract). Lead-with hook comes from the resume's `cover_letter_angle` (a specific CV achievement). *Why:* the cover letter is the one place to demonstrate you read the JD.
11. **Local files are the source of truth; Sheet is mostly a read-only mirror.** The exception is two writable columns on the Tray tab (`Action`, `Edits`) — the async approval surface. *Why:* avoids conflict resolution; phone-friendly approval.
12. **Approval is scoped.** Template approval gates the template, baseline approval gates reusable content, and Sheet or `/review-drafts` approval gates preparation of one application package. Sending is a separate gate with two lanes. On the autopilot channels (`autopilot.channels` in `submission-policy.yaml`) the authority is mechanical: an independent letter-critic pass on the exact letter (sha-matched) plus `tools/submission-gate.ts` with `autopilot:<run-id>` provenance. On every other channel the user must be present and freshly confirm the exact package at the action point. Kill switch, daily caps and technical validation remain defense in depth on both lanes. *Why:* asynchronous review must never silently become authority to contact an employer, and the unattended lane must be auditable line by line (every send is journaled with the full letter).
13. **Audit log is the legal-quality record.** Every state transition writes an append-only event to `state/audit/audit-log.jsonl`. Cross-channel dedup index prevents re-applying to the same company + role-family within 60 days, even if the role is posted on a different channel. *Why:* "did I already contact this recruiter?" is a recoverable question.
14. **URL canonicalisation before opportunity-id generation.** Seek serves the same job under different `#sol=` hash tokens per impression; LinkedIn varies query params per refresh. The harness canonicalises URLs (`tools/url-canonical.ts`) to stable path-only forms before hashing into opportunity ids. *Why:* without this, the same opportunity appears N times.

### Harness ↔ profile boundary

| Where | What lives there | Who maintains it |
|---|---|---|
| `tools/`, `agents/`, `.claude/skills/`, `.agents/skills/`, `scripts/`, `.claude/hooks/` | Framework code, schemas, generic agents, generic skills, automation glue. | Repo / forks |
| `templates/resume/`, `templates/cover-letter/`, `templates/linkedin/` | Artefact templates (renderers). Shared across profiles. Improvements compound for everyone. | Repo / forks (curated growth) |
| `state/org/` | Optional org-level resume type pool and shared voice/slop guardrails. If absent, individual mode behaves exactly as before. If `state/org/resume-types.yaml` exists, profile resume entries can either assign/override central types or define complete individual-only types. | Org / consulting practice |
| `state/profile/` | Identity, voice rules, slop banlist, resume list, screening answers, scoring weights, channel preferences, canonical CV content. | Per-user (you) |
| `state/pipeline/`, `state/audit/`, `state/journal/`, `state/market/`, `state/channels/` | Runtime state: opportunities, audit log, daily digests, market intel, browser session cookies. | Per-user (auto-written) |

Fork the repo + drop your own `state/profile/` content + opt-in your channels + approve your baselines = working harness. See [Getting started](#getting-started-new-person) for the exact sequence and [Privacy boundary](#privacy-boundary-and-open-sourcing) for what must never leave your machine.

### Repository layout

```
my-contracting/
├── AGENTS.md                              ← canonical agent contract (Codex CLI reads natively)
├── CLAUDE.md                              ← one-line `@AGENTS.md` import (Claude Code reads natively)
├── README.md                              ← human operating manual + this architecture section
├── package.json                           ← npm scripts (canonical CLI entry points for every tool)
├── tsconfig.json
├── .env / .env.example                    ← Sheet credentials + HARNESS_CLI=claude|codex
├── .gitignore
│
├── .claude/                               ← Claude Code config
│   ├── settings.json                      ← permissions allowlist/denylist + hook registration
│   ├── hooks/session-start.sh             ← short brief printed on session resume
│   └── skills/                            ← user-invokable workflows (auto-triggered + explicit /<name>)
│       ├── setup/                         ← /setup — guided first run: machine, profile, CV, positionings, logins, Sheet, schedule, autopilot
│       ├── apply/                         ← /apply <opp-id> — assemble + submit one application package
│       ├── daily/                         ← /daily — composite morning run (hunt + classify + draft + sync)
│       ├── follow-up/                     ← /follow-up — nudge stale awaiting-response opportunities
│       ├── hunt/                          ← /hunt [channel] — discover new opportunities, classify, score, ingest
│       ├── onboarding/                    ← /onboarding — first-run creation of resumes.yaml from CV evidence
│       ├── resume-strategy/               ← /resume-strategy — later strategy changes to resume positionings
│       ├── manual-applications/           ← /manual-applications — walk manual-action-needed rows (open URL, pre-fill, mark done)
│       ├── pipeline/                      ← /pipeline — summary counts by status; top items
│       ├── prep-interview/                ← /prep-interview <opp-id> — company research, STAR scenarios, questions to ask
│       ├── submit-approved/               ← /submit-approved — pull Sheet Tray.Action+Edits, reconcile, queue submissions
│       ├── rate-check/                    ← /rate-check — market rate snapshot for active resumes' search terms
│       ├── resume-render/                 ← /resume-render <resume-id> — single-resume baseline through resume-writer
│       ├── resume-review/                 ← /resume-review — batch walk all active resumes' baselines (approve/edit/skip)
│       ├── resume-critique/               ← /resume-critique <resume-id> — independent content review before any approval
│       ├── profile-report/                ← /profile-report — local HTML report for a profile or a consulting team
│       ├── review-drafts/                 ← /review-drafts — synchronous walk of pending Tray drafts (at the laptop)
│       └── refresh-cv/                    ← /refresh-cv — re-parse master CV from cv_source_dir; refresh canonical content
│
├── .codex/                                ← Codex CLI config
│   ├── agents/*.toml                      ← generated from agents/*.md via npm run codex:sync-agents
│   ├── hooks/session-start.sh             ← symlink to .claude/hooks/session-start.sh
│   └── config.toml                        ← model, approval_policy, sandbox_mode
│
├── .agents/                               ← Agent Skills standard mount point
│   └── skills/ → ../.claude/skills        ← symlink so Codex finds the same skills
│
├── agents/                                ← canonical subagents (Claude reads directly; Codex wrappers are generated)
│   ├── opportunity-finder.md              ← discover + classify + score → ingest
│   ├── resume-writer.md                   ← Stage 1: compose + render + audit a per-resume baseline
│   ├── cover-letter-writer.md             ← Stage 2: compose per-opportunity cover letter
│   ├── outreach-drafter.md                ← LinkedIn hiring-post comment + DM drafts
│   ├── submission-runner.md               ← drain approved queue, submit per channel, capture confirmation
│   ├── research.md                        ← interview prep + weekly market intel
│   └── state-syncer.md                    ← validate state + mirror to Sheet
│   (Application orchestration lives in the /apply skill, which spawns resume-writer
│    and cover-letter-writer as peer subagents when a package needs to be assembled.)
│
├── tools/                                 ← framework code — pure utilities, no LLM calls inside
│   ├── setup.ts                           ← first-run checks (9 stages, JSON) + profile scaffold; driven by /setup
│   ├── pipeline.ts                        ← state CRUD + status transitions over the SQLite store (tools/pipeline-store.ts)
│   ├── audit.ts                           ← append-only event log + cross-channel dedup index
│   ├── resumes.ts                         ← consume state/profile/resumes.yaml (Resume type + accessors)
│   ├── profile.ts                         ← read state/profile/profile.md frontmatter + slugify name for filenames
│   ├── classify-jd.ts                     ← Classification schema + regex triage classifier
│   ├── score.ts                           ← weighted scorer (takes pre-classified input)
│   ├── slop-killer.ts                     ← AI-slop phrase detector for drafts
│   ├── voice-check.ts                     ← sentence length, English variant, opener patterns
│   ├── sheets-sync.ts                     ← push state → Sheets; pull Tray Action+Edits (skipped when sheet.enabled is false)
│   ├── ui/                                ← the local approval UI (npm run ui): server, API, static assets
│   ├── rescore-pipeline.ts                ← bulk rescore with pre-computed classifications
│   ├── dedup-pipeline.ts                  ← one-shot URL re-canonicalisation + merge duplicates
│   ├── url-canonical.ts                   ← strip per-impression tracking tokens from job URLs
│   ├── onboarding.ts                      ← deterministic glue for /onboarding skill (context, write-resume)
│   ├── verify-plan.ts                     ← closed-loop verifier and smoke checks
│   ├── channels/                          ← pluggable channel modules
│   │   ├── _interface.ts                  ← HuntChannel { id, search, submit? }
│   │   ├── _browser.ts                    ← shared real-Chrome launcher (persistent profile + stealth)
│   │   ├── seek.ts, seek-submit.ts        ← Seek.com.au scrape + (planned) Quick Apply
│   │   ├── linkedin-jobs.ts, -posts.ts    ← LinkedIn (logged-in via persisted Chrome profile)
│   │   ├── hn-who-is-hiring.ts            ← Algolia HN search API (no login)
│   │   │                                    (hays / talenza / paxus / robert-half / peoplebank /
│   │   │                                     wellfound are ids in channels.yaml with no adapter yet)
│   │   └── README.md                      ← how to add a channel
│   ├── cv/                                ← INPUT-side: parser for the master CV
│   │   └── markdownify-cv.ts              ← .docx → state/profile/cv-source.md
│   └── resume/                            ← OUTPUT-side: render + audit + approve per-resume artefacts
│       ├── resume-renderer.ts             ← dispatcher: materialise AI-composed --content-json
│       ├── resume-lint-ats.ts             ← post-render ATS-friendliness check
│       ├── resume-evaluate.ts             ← research-backed rubric evaluator (headings, density, page budget, evidence)
│       ├── resume-to-images.ts            ← PDF → PNG pages (so resume-writer can visually inspect)
│       ├── resume-golden.ts               ← regenerate profile-neutral template golden samples
│       └── resume-approve.ts              ← per-resume baseline approval (content_hash gating)
│
├── templates/                             ← harness-level artefact templates (shared across profiles)
│   ├── profile/                           ← neutral skeleton of every state/profile file; `npm run setup:scaffold` copies it
│   ├── resume/                            ← Resume templates — each is a renderer (code)
│   │   ├── _interface.ts                  ← ResumeContent, RenderOptions, ResumeTemplate, ExperienceItem (feature|mention)
│   │   ├── _html-resume.ts                ← shared content → HTML builder for presentation PDFs
│   │   ├── _html-helpers.ts               ← HTML/PDF rendering, font embedding, linkification
│   │   ├── _ats-docx.ts                   ← shared plain ATS docx renderer
│   │   ├── _pandoc-helpers.ts             ← `assembleMarkdown` only — builds the canonical `.md` artefact (no pandoc)
│   │   ├── <name>/render.ts               ← template implementation (default export: ResumeTemplate)
│   │   ├── <name>/template.md             ← template metadata (name, description, suitable_for, version)
│   │   ├── <name>/quality-checks.md       ← per-template overrides (rare; overlay universal checks)
│   │   ├── <name>/rubric.yaml             ← research-backed constraints: headings, density, page budget, evidence thresholds
│   │   ├── <name>/sample/                 ← profile-neutral golden output: sample-content.json, md, html, docx, pdf, PNG pages
│   │   ├── classic/                       ← executive editorial template; serif, conservative, 3-page budget
│   │   ├── modern/                        ← contemporary operator template; Inter + teal accent, 2-3 page budget
│   │   ├── minimalist/                    ← bare typography template; tight 2-page budget
│   │   ├── fonts/                         ← bundled libre fonts for deterministic HTML/PDF output
│   │   ├── _archived_20260528/            ← old low-level/legacy templates kept out of the active set
│   │   └── README.md
│   ├── cover-letter/                      ← declarative cover-letter templates (frontmatter + composition rules)
│   │   └── classic/                       ← AU conservative, 250-350 words, 2-4 paragraphs
│   └── linkedin/                          ← LinkedIn comment + DM templates (planned)
│
├── scripts/                               ← installation + automation glue
│   ├── daily.sh                           ← launchd entry point — invokes `claude -p` or `codex exec`
│   ├── install-launchd.sh                 ← installs ~/Library/LaunchAgents/com.job-hunt-harness.daily.plist
│   └── login-channel.ts                   ← opens real Chrome for one-time login (cookies persist)
│
├── docs/resume-research/                  ← source-backed resume claims used by template rubrics
│   ├── README.md
│   └── claims.yaml
│
├── tests/
│   └── fixtures/                          ← canonical fixtures (sloppy-cover, in-voice cover, sample JD, sample ResumeContent)
│
└── state/                                 ← per-profile content + runtime state (all git-friendly markdown / JSON / YAML)
    ├── profile/                           ← YOU live here. Identity, voice, resumes, CV.
    │   ├── profile.md                     ← name, contact, citizenship, locale, rate band, red flags
    │   ├── voice-rules.md                 ← sentence length, English variant, openers to avoid
    │   ├── voice-samples.md               ← your actual writing — drafts mimic this cadence
    │   ├── slop-banlist.md                ← AI-slop phrases never to use (grows with your edits)
    │   ├── scoring-weights.yaml           ← per-input scoring weights (rate / arrangement / etc.)
    │   ├── skills-taxonomy.yaml           ← canonical skills + synonyms (for keyword matching)
    │   ├── channels.yaml                  ← which channels are enabled + per-channel config
    │   ├── resumes.yaml                   ← go-to-market: which resumes you maintain + their search keywords + cover-letter angles + rate bands
    │   ├── screening-answers.yaml         ← canonical answers (right-to-work, notice, rate, years-with-X)
    │   ├── submission-policy.yaml         ← kill switch, daily cap, per-channel auto_submit opt-in
    │   ├── cv-source.md                   ← canonical holistic CV source parsed from the master .docx
    │   ├── cv/                            ← parser metadata and archived pre-holistic CV split
    │   │   └── meta.yaml                  ← source file + parsed_at
    │   └── resumes/                       ← rendered baseline resumes (OUTPUT per resume entry in resumes.yaml)
    │       └── <resume-id>/               ← resume_<profile-slug>_<resume-id>.{docx,pdf,md}, metadata.json, editorial-rules.md (per-resume learning loop)
    │
    ├── pipeline/
    │   ├── pipeline.db                    ← SQLite store: every opportunity, status, classification, score, history (the record)
    │   ├── opportunities.json             ← on-demand export (`npm run pipeline -- export`); never a source
    │   ├── opportunities.md               ← auto-generated human digest
    │   └── archive/<opportunity-id>/      ← per-opportunity package: jd.md, resume_<slug>_<resume-id>.docx, cover-letter.md, metadata.json, confirmation.png
    │
    ├── audit/                             ← append-only event log + cross-channel dedup index
    │   ├── audit-log.jsonl
    │   ├── dedup-index.json
    │   └── contacts.jsonl                 ← per-contact event stream (recruiters, HMs)
    │
    ├── channels/storage-state/            ← persisted browser profiles (Playwright + real Chrome)
    │   └── chrome-profile/<channel>/      ← per-channel Chrome user-data-dir (Seek, LinkedIn, …)
    │
    ├── contacts/                          ← (planned) curated contact book (recruiters, HMs, last-touch)
    ├── market/                            ← market intel snapshots (rate trends, in-demand skills)
    ├── journal/YYYY-MM-DD.md              ← daily digest (counts, top finds, decisions)
    ├── journal/launchd/                   ← stdout/stderr per launchd run
    └── rejected/ignore.json               ← skip-list (companies / recruiters / role patterns)
```

### Extension points

Adding new things to the harness — always profile or repo-side, never both.

| To add a | Where | What it needs |
|---|---|---|
| **Resume** (new positioning the harness hunts for) | `state/profile/resumes.yaml` entry | id, label, search_keywords, should/could/flagged, cover_letter_angle, rate_band, preferred_channels, template, notes. `/onboarding` creates the first set; `/resume-strategy` changes them later. Each resume entry maps to one `state/profile/resumes/<id>/` dir holding the baseline artefacts (docx, pdf, md, metadata.json). |
| **Org resume type** (central consulting-role pool) | `state/org/resume-types.yaml` | Same base fields as a profile resume, plus optional `market_lens` (`must_signal`, `keyword_aliases`, `proof_questions`, `forbidden_claims`). When this file exists, profile entries with matching ids merge against central types; complete profile-only entries remain valid for individual freedom; incomplete unknown assignments fail validation. |
| **Experience** (job-history item in your master CV) | `state/profile/cv-source.md` | The holistic master-CV markdown parsed from the source `.docx`. `resume-writer` reads this as one narrative evidence base and composes resume/template-specific `ResumeContent`. |
| **Template** (resume visual style) | `templates/resume/<name>/render.ts` + `template.md` + `quality-checks.md` + `rubric.yaml` + `sample/` | A reusable renderer that takes AI-composed `ResumeContent`. Active profile-facing templates are `classic`, `modern`, and `minimalist`. Samples are rendered from `tests/fixtures/resume-content/senior-operator.json`, not the active profile, and committed as `sample/golden.*`. `npm run resume:evaluate` must pass for samples and production resumes. |
| **Channel** (job source) | `tools/channels/<id>.ts` | Implements `HuntChannel { search, submit? }`. Add to `channels.yaml`. Optional `<id>-submit.ts` for auto-submit support. |
| **Skill** (user-invokable workflow) | `.claude/skills/<name>/SKILL.md` | YAML frontmatter (name, description for triggering) + agent instructions. Read by both Claude Code and Codex CLI. |
| **Subagent** (specialised reasoning unit) | `agents/<name>.md` | YAML frontmatter (name, description, model, tools) + system prompt. Invoked by skills via the Agent tool. |

### Individual + org resume type modes

The same resolver supports three practical modes:

- **Individual mode**: keep only `state/profile/resumes.yaml`. Every resume entry is a full, profile-owned positioning.
- **Org assignment mode**: copy `state/org/resume-types.example.yaml` to `state/org/resume-types.yaml`, then make profile entries lightweight assignments such as `resumes: [{ id: ai-engineering-lead, active: true }]`.
- **Hybrid mode**: use central org types for managed roles, while keeping complete profile-only entries in `state/profile/resumes.yaml` for individual freedom.

Useful checks:

```bash
npm run resume-types:list                 # resolved types for the default profile
npm run resume-types:validate             # validate default + team profiles
npm run team:matrix -- --profile all      # profile × resume-type render/approval status
npm run resume:market-audit -- --resume applied-ai
```

For team profiles, create `state/profiles/<person-id>/profile.md`, `cv-source.md`, `voice-samples.md`, and `resumes.yaml`. Most resume/render/provenance utilities accept `--profile <person-id>` or respect `HARNESS_PROFILE=<person-id>`.

### Local profile and team reports

Generate local HTML reports when you want one browser view of the source inputs, resolved Resumes, generated resume artefacts, approval metadata, provenance, and market-alignment gaps.

```bash
npm run profile:report
npm run profile:report -- --profile <person-id>
npm run team:report
```

Default outputs are `state/profile/profile-report.html`, `state/profiles/<person-id>/profile-report.html`, and `state/org/team-report.html`. Reports link heavy artefacts locally rather than embedding them: PDFs and generated HTML render in iframes; DOCX, Markdown, JSON, and page PNGs are linked or previewed. The deterministic shell lives in `templates/profile-report/report-template.html`; the `/profile-report` skill can generate a small `--generated <json>` narrative payload for profile-specific commentary before the renderer fills the template.

### What's intentionally NOT here

- ADRs / decision logs. v1 — no drift yet to capture. This Architecture section is the current statement.
- Broad template gallery beyond `classic`, `modern`, and `minimalist`. Library grows as we develop more.
- Full multi-user / team workflow UI. v1 has optional org resume-type and voice guardrails, path support for `state/profiles/<person-id>`, validation/list/matrix CLIs, and no database or permissions model.
- Direct provider billing. The harness assumes your CLI (Claude Code, Codex) is already authenticated; it doesn't ask for API keys.

## Getting started (new person)

The fastest path is to let the agent do it. After the three commands below, open Claude Code (or Codex) in the repo and type `/setup`. It runs `npm run setup:check`, sees what is missing, and walks you through each stage with short question batches, re-checking as it goes, until autopilot is on. Budget an afternoon; most of it is your own profile content and one CV review, not tooling.

```bash
git clone <this-repo> job-hunt && cd job-hunt
npm install
npx playwright install chromium && brew install poppler     # Chromium renders PDFs; poppler counts pages
claude            # or: codex
> /setup
```

Everything under `state/` that describes you (profile, CV, positionings, pipeline, audit, journal, browser sessions) is `.gitignore`d and stays on your machine. See [Privacy boundary](#privacy-boundary-and-open-sourcing).

### What /setup does, stage by stage

`npm run setup:check` prints one JSON object with nine stages and the first blocked one; `/setup` works that list. You can run any stage by hand instead; the commands are the same.

| Stage | What is checked | What you do (or the agent asks) |
|---|---|---|
| 0 machine | Node 20+, poppler, Playwright Chromium, `.env` | run the printed `brew` / `npx` fix commands |
| 1 profile | every `state/profile/` file exists, `profile.md` frontmatter valid, no `TODO`s, at least 200 words of voice samples | `npm run setup:scaffold` copies `templates/profile/`; the agent asks name, contact, citizenship, clearance, rate, work arrangement, role families, industries to avoid; you paste 3 to 5 emails or posts you wrote |
| 2 cv | `cv-source.md` present with role headers | give the path to your master `.docx`; `npm run markdownify:cv -- --source <path>`; read the result once |
| 3 positionings | `resumes.yaml` has active entries | `/onboarding` proposes 3 to 6 positionings from the CV and you confirm |
| 4 baselines | every active positioning has an approved, unchanged baseline CV | `/resume-review` renders, audits, critiques, and walks you through approval (minutes per positioning) |
| 5 channels | enabled channels have a saved login | pick channels in `channels.yaml`; run `npm run login:seek` / `login:linkedin` yourself (a browser opens, you log in once) |
| 6 sheet (optional, off by default) | `sheet.enabled`, then key file readable and spreadsheet reachable | skipped while `sheet.enabled: false` (the local UI is the approval surface). To add the phone Tray: set `sheet.enabled: true`, then a service account + JSON key, an empty Sheet shared with the service-account email as Editor, two lines in `.env`; `npm run sheets:sync` creates the tabs |
| 7 schedule | launchd job loaded, `HARNESS_CLI` set | `bash scripts/install-launchd.sh` (macOS); a cron line for `scripts/daily.sh` elsewhere |
| 8 autopilot | policy parses, kill switch off, `autopilot.enabled`, channels listed | after at least one attended `/apply`, answer "turn autopilot on?" and the agent writes `submission-policy.yaml` |
| 9 ui (informational) | UI launchd job installed and pointing here, `127.0.0.1:7788` answering | `npm run ui` when you want it, `bash scripts/install-ui-launchd.sh` to keep it running; never blocks `ready_for_autopilot` |

`ready_for_autopilot: true` means the 07:00 run will import your saved SEEK jobs, hunt, draft, and send one-click applications that pass the letter-critic and the gate, and journal every send with the full letter.

### Doing it by hand

Each stage's commands are in the table. The only things the agent cannot do for you are the shell installs in stage 0, the browser logins in stage 5, and the Google Cloud clicks in stage 6. `npm run setup:check -- --stage N` checks one stage.

### Turning autopilot off

`kill_switch: true` in `state/profile/submission-policy.yaml` halts every send, attended or not. `autopilot.enabled: false` halts only the unattended lane. Both take effect on the next run.

## Local UI

The local UI is the primary approval surface. It reads and writes the same SQLite pipeline the CLI does, so a decision you make in it is the decision, with no sync step and no Google account.

```
npm run ui                       # http://127.0.0.1:7788
npm run ui -- --open             # and open a browser
npm run ui -- --port 7799        # a different port
```

It serves the same work the Sheet Tray did: the day's summary, every row with its classification and score, the pending keyword questions, today's journal and the critic digest, plus the per-row actions (approve, reject, hold, edit). Approving a row is preparation, exactly as in the Sheet: sending still obeys the two lanes in `AGENTS.md` section 2.

### From your phone

The server binds `127.0.0.1` by default, so nothing off this machine can reach it. To use it from a phone:

1. Put the phone and the laptop on the same network. [Tailscale](https://tailscale.com) is the safer option, because the laptop keeps the same address on any network and nothing is exposed to the LAN; a plain Wi-Fi LAN works too.
2. Choose a long random token and export it, for example `export HARNESS_UI_TOKEN=$(openssl rand -hex 24)`. The server refuses a non-local bind without one.
3. Start it bound to that address: `npm run ui -- --host 100.x.y.z` (your Tailscale address), or `--host 0.0.0.0` on a trusted LAN.
4. On the phone, open `http://<that address>:7788/`, open Settings (the cog at the top right), paste the token into the API token field and save. The browser keeps it locally and sends it as a bearer header on every call.

Treat the token like a password: it is the only thing between the network and your pipeline. Never put it in a journal entry, a commit or a screenshot.

### Keeping it running

```
bash scripts/install-ui-launchd.sh              # render + install + load the launchd job
bash scripts/install-ui-launchd.sh --dry-run    # print the rendered plist, change nothing
bash scripts/install-ui-launchd.sh --port 7799  # a different port
bash scripts/install-ui-launchd.sh --uninstall  # unload and remove it
```

It renders `templates/launchd/com.job-hunt-harness.ui.plist` with this checkout's path and installs it to `~/Library/LaunchAgents/com.job-hunt-harness.ui.plist`. `RunAtLoad` and `KeepAlive` mean it starts at login and comes back if it dies. Logs land in `state/journal/launchd/ui.log`. Re-running it is safe: the job is booted out and bootstrapped again. To bind beyond localhost from the launchd job, uncomment `HARNESS_UI_TOKEN` in the installed plist, add `--host <address>` to the command in `ProgramArguments`, and `launchctl kickstart -k gui/$UID/com.job-hunt-harness.ui`.

`npm run setup:check` reports all of this as stage 9. It is informational: a UI that is not installed or not running never blocks anything.

### The Google Sheet is now optional

`sheet.enabled` in `state/profile/submission-policy.yaml` decides whether the Sheet mirror runs at all:

```yaml
sheet:
  enabled: false     # the local UI is the approval surface
```

With it off, `npm run sheets:sync`, `npm run sheets:pull` and the `/daily` Sheet steps exit 0 immediately with `{"command":"push","ok":true,"skipped":"sheet.enabled=false"}`, no Google client is built and no credentials are needed; `npm run daily:summary` reports `sheet: "disabled"`; `setup:check` marks stage 6 `skipped` rather than blocked. A profile with no `sheet:` block keeps mirroring, so nothing changes for an existing setup until you say so. The two surfaces also run side by side: set `sheet.enabled: true` and you get the phone Tray as well, with the UI still primary. `post_submit.write_back_to_sheet` remains the write half and only applies while the Sheet is enabled.

## Daily mobile workflow

This is the Google Sheet route, for when `sheet.enabled: true`. With the Sheet off, do the same thing in the local UI from your phone (see "From your phone" above): the rows, the actions and the effect are identical.

1. Open the Google Sheet on your phone.
2. Switch to the **Tray** tab. New rows show up overnight with: role title, company, channel, score, top match reasons, top red flags, CV variant chosen, the first 2 sentences of the cover letter, a link to the rendered PDF.
3. Tick the `Action` column per row: `approve` / `reject` / `edit` / `hold`. For `edit`, type the change into the `Edits` column ("shorten para 2", "use day rate $1400 not $1500", "lead with the ServiceNow ESM win").
4. Close the Sheet.
5. By lunchtime, the next harness run has processed your decisions: approved rows are prepared as complete packages (and, on an autopilot channel, sent if the gates pass), edits are re-drafted and back in the tray, and rejects are removed from consideration. Rows the harness could not finish sit in `manual_action_needed` with the reason in the notes column.

## Optional laptop workflow

When you're at the laptop and want to qualify a batch synchronously. Every workflow is a **skill** (`.claude/skills/<name>/SKILL.md`) — both Claude Code and Codex CLI auto-trigger them on intent, or you can invoke directly with `/<name>`:

```
/setup              guided first run on a new machine, ends with autopilot on
/daily              the unattended orchestrator (also fired by launchd cron)
/hunt [channel]     discover new opportunities across enabled channels
/review-drafts      walk pending drafts interactively; approve/edit/reject in-flow
/submit-approved    attended review and exact confirmation before submission
/manual-applications walk rows that need you to submit manually
/pipeline           status summary
/apply <opportunity-id>    one-shot interactive submit for a single opportunity
/follow-up          surface stale apps + draft follow-ups
/prep-interview <opportunity-id>  company research + STAR brief
/rate-check         market intel snapshot
/refresh-cv         re-parse latest CV from cv_source_dir
```

Or just describe what you want in plain English — Claude / Codex will pick the matching skill from its description.

## Operating modes and UX

The harness has two practical operating modes. They share the same code path; the difference is where resume types and profile content live.

### Individual mode

Use this when one person is running their own search and wants freedom to pursue any credible positioning.

1. Keep the canonical profile in `state/profile/`.
2. Keep resume positionings in `state/profile/resumes.yaml`.
3. Run `/onboarding` to create the first set of positionings from the CV.
4. Run `/resume-strategy` when the market strategy changes.
5. Run `/resume-review` to approve one baseline CV per active positioning.
6. Run `/daily`, review the Sheet Tray, and approve/reject/edit applications.

If `state/org/resume-types.yaml` is absent, `state/profile/resumes.yaml` is fully standalone. If org mode is present, the individual profile can still keep complete profile-only entries for free-form roles outside the central pool.

Useful checks:

```bash
npm run resume-types:list
npm run resume:market-audit -- --resume applied-ai
npm run team:matrix
```

### Market-guided source completion

Use this when the CV points in a direction, but the source wording does not yet market it well. Example: the person is now positioning around Claude Code or applied-AI delivery, but the source CV only says "agent workflows" or "delivery automation".

1. Run `/resume-strategy` and name the market focus to refresh, e.g. "review the applied-ai lens for Claude Code".
2. The agent researches current role/tool expectations and produces a compact capability map: expected capabilities, market aliases, source evidence patterns, proof questions, and forbidden claims.
3. The agent compares that map against `cv-source.md` and updates `market_lens` with safe aliases plus targeted proof questions.
4. `/resume-render` uses the lens but does not research again. It renders only `explicit` and defensibly `implicit` signals; uncertain signals are audit questions, not resume claims.
5. When the user answers a question, record the answer in `<profile-dir>/market-confirmations.yaml`.
6. If the answer confirms a fact, update `<profile-dir>/cv-source.md` before re-rendering. Prior composition JSON is audit history, not source truth.

Confirmation ledger shape:

```yaml
confirmations:
  - resume_id: applied-ai
    signal: automated quality scoring
    question: Were evals or automated quality scoring used beyond cross-model review and human sign-off?
    status: pending        # pending | confirmed | declined | not_applicable
    source_update_required: true
    source_ref: null
    notes: ""
    updated_at: "2026-06-08"
```

Ledger semantics:

- `confirmed` suppresses repeat questions, but the claim still cannot render until `cv-source.md` contains evidence.
- `declined` and `not_applicable` suppress repeat questions unless the lens or source materially changes.
- `pending` stays as an outstanding action, not a fresh question.
- `cv-source.md` remains the source of truth for rendered facts.

Interactive UX:

- Claude Code should ask these via `AskUserQuestion`.
- Codex should ask these via `request_user_input` when the tool is available.
- Use structured choices such as "Confirm and update source", "Not applicable", "Bring in as familiarity", and "Unsure / keep pending"; let the tool's custom/Other field capture detail.
- Do not bury market-gap questions as inline prose when a structured question surface is available.

### Interaction mode split

Use the CLI mode that matches the job:

- **Plan mode** — user judgement, market-gap discovery, approval choices, source-completion questions.
- **Default mode** — file edits, composition refresh, rendering, audits, deterministic validation.

Recommended flow:

1. Run `/resume-strategy` or `/resume-review` in Plan mode when `market_alignment.confirmation_needed` or `market_alignment.open_questions` exist.
2. Ask structured questions through Claude Code `AskUserQuestion` or Codex `request_user_input`.
3. Store answers in `state/profile/market-confirmations.yaml` or `state/profiles/<person-id>/market-confirmations.yaml`.
4. For confirmed facts, update `cv-source.md` or run `/refresh-cv` before rendering.
5. Switch to Default mode for the render itself: `/resume-render`, which routes through `resume-writer` and `resume:audit`, then `resume:evaluate`, provenance, ATS lint, and slop checks. Never call `resume:render:raw` or `resume:audit` yourself for a production artefact (AGENTS.md section 5).

Pragmatic rule: do not force every run through Plan mode. Use it only when structured user judgement is needed.

### Team / consulting-org mode

Use this when a consulting practice wants a centrally managed pool of role/resume types, but each consultant still has their own evidence, voice samples, rates, and approved baselines.

1. Maintain the allowed role pool in `state/org/resume-types.yaml`.
2. Put shared brand/voice/compliance rules in `state/org/voice-rules.md` and `state/org/slop-banlist.md` when needed.
3. Create one profile directory per consultant: `state/profiles/<person-id>/`.
4. Each consultant profile gets `profile.md`, `cv-source.md`, `voice-samples.md`, and `resumes.yaml`.
5. In each consultant's `resumes.yaml`, activate only the central role types valid for that person and add person-specific overrides.
6. Render/review baselines per consultant and role type before sending anything to clients.

Useful checks:

```bash
npm run resume-types:validate
npm run resume-types:list -- --profile <person-id>
npm run team:matrix -- --profile all
npm run resume:market-audit -- --resume applied-ai --profile <person-id>
```

For production baselines, use the audited skill flow rather than calling the renderer directly: ask `/resume-render <resume-id> for profile <person-id>` or say "render the <resume-id> baseline for <person>". The skill composes `ResumeContent`, runs the quality/provenance checks, then calls `resume:render:raw` with the required composition JSON.

### Decision rules

- **Central role types define the market.** Search terms, should/could/flagged signals, templates, and `market_lens` live in `state/org/resume-types.yaml` when the org wants consistency.
- **Profiles define the person.** CV evidence, rates, voice samples, screening answers, and person-specific positioning stay in `state/profile/` or `state/profiles/<person-id>/`.
- **Market language is evidence-gated.** A role type may say the market expects "harness engineering" or "AI delivery governance", but rendered resumes can use those terms only when `cv-source.md` supports them explicitly or through configured aliases.
- **Market research refreshes the lens, not every render.** `/resume-strategy` and `/onboarding` research current domains/tools when the strategy changes; `resume-writer` consumes the resulting `market_lens` and keeps rendering fast, auditable, and repeatable.
- **Judgement gaps become questions.** When the model sees a valuable but uncertain market signal, it should ask a targeted question instead of silently omitting it forever or inventing it. If the answer confirms the fact, update `cv-source.md` first, then re-render.
- **Answered gaps are remembered.** Store proof-question answers in `<profile-dir>/market-confirmations.yaml` so future renders do not ask the same question repeatedly.
- **Deterministic checks are guardrails, not judges.** Code should catch broken paths, missing metadata, unsupported claim fields, banned phrases, and approval gates. The model plus user owns semantic judgement: whether an implicit signal is fair, whether a market term is useful, and whether a gap is worth adding to the canonical source.
- **Do not duplicate generated artefacts for a new team profile.** Copy source and editorial inputs; render fresh baselines so provenance, metadata, and approval status belong to that profile.

## Updating your profile

- **CV content** — edit your master `.docx` (the path recorded in `state/profile/cv/meta.yaml`), then `/refresh-cv`. The harness re-parses and shows you a diff before saving.
- **Add a new bullet** — edit the master CV in `cv_source_dir`, then run `/refresh-cv`; for a surgical local change, edit `state/profile/cv-source.md` and re-render the affected baseline so provenance is regenerated.
- **Tune scoring** — edit `state/profile/scoring-weights.yaml`. Re-score the pipeline with `npm run pipeline:rescore -- --classifications state/pipeline/classifications.json`.
- **Tune voice** — your edits in `/review-drafts` and the Sheet's `Edits` column feed back automatically. You can also hand-edit `state/profile/{voice-rules.md, slop-banlist.md}` directly.

## Submission policy & guardrails

`state/profile/submission-policy.yaml` is read by `tools/submission-gate.ts` on every send, attended or not:

```yaml
kill_switch: false                  # true halts every submission immediately, attended or unattended
max_auto_submits_per_day: 100       # attended cap
per_channel_rate_limit_per_hour: 10

autopilot:
  enabled: false                    # flip on only after a few attended runs
  channels: [seek, linkedin_jobs]   # only channels with a one-click adapter (tools/channels/*-submit.ts)
  max_per_day: 30                   # counted on audit `submitted` events with actor "autopilot"
  require_letter_critic_pass: true  # <archive>/letter-critic.json verdict pass, sha matches cover-letter.md
  core_discipline_only: true        # non-saved rows must be classification.discipline_fit core
  saved_jobs_bypass_fit_gates: true # a job you saved on SEEK skips discipline/location/duplicate gates
  journal_every_send: true          # full letter text under "Sent unattended" in the day's journal
  unsave_after_apply: true
```

What the gate checks before any send (`tools/submission-gate.ts`, covered by `tests/submission-gate.test.ts`):

- provenance token: `autopilot:<run-id>` is accepted only while `autopilot.enabled` is true and the channel is in `autopilot.channels`; anything else needs an attended approval token
- kill switch off; daily caps not reached (attended and autopilot counted separately)
- status `approved`, agent classification present, no `red_flag_blocker` (bypassed for user-saved rows)
- baseline CV approved and its content hash unchanged since approval
- letter-critic pass whose sha256 matches the exact `cover-letter.md`
- `resume-lint-ats` pass on the CV, `slop-killer` and `voice-check` pass on the letter
- rate set in `profile.md`
- 60-day cross-channel dedup (skipped for user-saved rows; a shared requisition released to several recruiters is applied to once per recruiter, see `representation_policy` in the YAML)

Every non-send outcome (critic block, gate failure, external ATS redirect, unknown screening question, adapter failure) lands the row in `manual_action_needed` with the reason in `notes`. Post-submit confirmation text and a screenshot are captured under `state/pipeline/archive/<opportunity-id>/`.

## What runs unattended

The launchd job at 07:00 (your local timezone) runs `scripts/daily.sh`, which invokes the `/daily` skill in the CLI named by `HARNESS_CLI`:

1. Pull the Sheet's `Tray.Action` + `Tray.Edits` columns; reconcile the manual queue.
2. Import the jobs you saved on SEEK (`npm run seek:saved -- --upsert`). A saved job is an order to apply: nothing parks it except a non-Quick-Apply ad or an unknown screening question, and a saved row that is not yet `submitted` is retried every run, whatever its status.
3. Hunt all enabled channels; classify in-agent; score deterministically; ingest.
4. Draft a package (baseline or tailored CV, cover letter, keyword plan) for every shortlisted and saved row; run slop, voice and the letter-critic.
5. `npm run autopilot:submit` for each package on an autopilot channel. A critic block on a *saved* row triggers up to two letter regenerations with the findings before parking; non-saved rows park on the first block for you to read.
6. Push state to the Sheet; write `state/journal/YYYY-MM-DD.md` with counts, top finds, "Sent unattended" (full letters) and "Parked by autopilot" (reasons).

The unattended job never invokes `submission-runner`, `npm run submit:*`, a recruiter message send, or any external portal outside the one-click adapters.

Logs land in `state/journal/launchd/YYYY-MM-DD.log` (JSONL transcript of the CLI session) and `state/journal/summary/`.

## Screening answer bank

`state/profile/screening-answers.yaml` holds canonical answers (right-to-work, notice, rate band, years-with-X, salary expectation). When an attended submission hits a screening question it cannot confidently match, it:

1. Halts the submission for that role.
2. Captures the question text into the Sheet's `screening-questions-needs-answer` tab.
3. You add the answer (in the Sheet or directly to the YAML).
4. A later attended session may resume that exact role after fresh confirmation.

Builds up a robust answer bank without guessing.

## Interview workflow

```bash
/prep-interview <opportunity-id>
```

Runs the `research` agent in `interview` mode. Output lands at `state/pipeline/archive/<opportunity-id>/interview-brief.md`:

- Company background, recent news, financial situation, key people.
- Role-relevant STAR scenarios pulled from your CV.
- Likely questions for this role + suggested angles.
- Questions you should ask them.

Post-interview, drop notes into `state/pipeline/archive/<opportunity-id>/interview-notes.md`; the next `/follow-up` run uses them to draft a thank-you.

## Pipeline statuses

`discovered → shortlisted → drafted → awaiting_approval → approved → submission_pending → submitted → responded → interview → offered → won`

Holds: `parked` (fits, but held for a logistics reason such as an interstate role needing routine onsite attendance) and `awaiting_external` (waiting on something outside the harness).

Terminal/diverted: `rejected`, `withdrawn`, `manual_action_needed`.

Full meanings, who may move a row, and the allowed transitions are in `docs/pipeline-state-machine.md` (`VALID_TRANSITIONS` in `tools/pipeline.ts` enforces them).

### Pipeline store

Rows live in SQLite at `state/pipeline/pipeline.db` (`tools/pipeline-store.ts`, WAL). Read and mutate them only through the CLI: `npm run pipeline -- get <id> | list | summary | export | migrate`, plus `upsert` and `set-status` for writes. `state/pipeline/opportunities.md` is the human digest regenerated by `state-syncer`; `state/pipeline/opportunities.json` is an on-demand export produced by `npm run pipeline -- export`, never a source to read from or edit.

## The full process (what runs, in order, every day)

This is the canonical lifecycle an opportunity passes through. The `/daily` skill orchestrates the whole thing; you can also invoke individual stages.

### 1. Hunt (channel scrapers → discovered/shortlisted)

`opportunity-finder` runs `npm run hunt:<channel> -- --upsert` for each enabled channel (the scripts that exist are `hunt:seek`, `hunt:linkedin-jobs` and its `hunt:linkedin_jobs` alias, `hunt:linkedin-posts` and `hunt:hn`). Each scraper returns raw opportunity data (title, company, URL, full JD body). `pipeline.upsert()` writes them with `status: discovered`, audit-logs a `discovered` event, and runs the cross-channel dedup check (same company + role-family within 60 days?).

### 2. Classify (agent reasoning → structured signals + profile_relevance + matched_resume_id)

All meaningful reasoning happens IN-AGENT. The agent (Claude Code or Codex CLI running interactively, or via `claude -p` from the launchd daily job) reads the JD plus `resumes.yaml` plus profile context, then produces a structured `Classification` conforming to the schema at `npm run classify:schema`.

The classification covers: red flags, bonuses, work arrangement, day-rate (extracted from JD), seniority, contract length, exclusivity, PAYG status, industry, **profile_relevance (0-100)**, detected domain, **matched_resume_id** (which active resume this opportunity best fits), and a 1-sentence explanation.

For high-volume hunts (50-200 opportunities) the agent spawns subagents in parallel via the Agent tool — each subagent classifies a subset in its own context window.

No Anthropic API key needed. Tools don't call the SDK. The agent uses its own LLM context (your Claude Code subscription credits).

A regex-only diagnostic classifier exists at `npm run classify:diagnostic` for cases where the agent isn't in the loop. The regex output defaults `profile_relevance` to 50 — a neutral middle — because regex genuinely can't judge fit; the agent must re-classify before shortlist, drafting, or submission.

### 3. Score (weighted + relevance-gated → updated status)

`tools/score.ts` produces a 0-100 score using `state/profile/scoring-weights.yaml`:

```
base = (skills_overlap × 0.30) + (work_arrangement × 0.25) + (seniority × 0.20)
     + (flexibility × 0.10) + (rate × 0.05) + (industry × 0.05) + (recency × 0.05)
final = base × max(0.15, profile_relevance / 100) + bonuses - penalties
```

**profile_relevance is a multiplier, not an additive.** A GPU/datacenter role for an enterprise IT consultant gets ~10/100 from the agent → base × 0.10 → crushed regardless of remote/fractional bonuses. A wholly-relevant role gets ~85-100 → base × 0.85+ → full credit. Adjacent roles (40-65) get proportional weighting. The hard floor of 0.15 means very-niche roles still appear at the bottom of the list rather than being invisible.

Opportunities with `profile_relevance < 25` are flagged `red_flag_blocker: true` and cannot pass the submission validation gate.

Opportunities scoring ≥ `shortlist_min_score` (default 55) get promoted `discovered → shortlisted`.

### 4. Draft (/apply skill → awaiting_approval)

For each `shortlisted` opportunity with score ≥ `draft_min_score` (default 70) and no red-flag blocker:

1. The classifier picks the matched resume positioning from `state/profile/resumes.yaml` and decides whether the approved baseline is enough or whether a high-fit JD needs tailoring.
2. `resume-writer` composes a resume/template-specific `ResumeContent` from the holistic CV source, the positioning brief, the selected template rubric, and optional JD context. It does not pre-bake generic content outside the template.
3. `resume-renderer` materialises only the composed JSON: presentation PDF via the active template and a shared ATS-safe docx for portals.
4. `resume:evaluate`, `resume-lint-ats`, PDF page-image inspection, and the template quality checks gate the CV. Auto-fixable density/page-fit issues iterate inside `resume-writer`.
5. `cover-letter-writer` writes a 2-4 paragraph cover letter in your voice using `references/voice/voice-rules.md`, `references/voice/slop-banlist.md`, and `state/profile/voice-samples.md`.
6. `slop-killer` scans the cover letter for AI-slop phrases. `voice-check` checks sentence length, AU English, opener patterns, and punctuation discipline.
7. Both checks must verdict `pass` or `warn`. Hard `fail` → regenerate (up to 4 times) with the failing phrases as explicit "don't use" instructions. If still failing, the opportunity stays in `drafted` (not `awaiting_approval`) and the persistent issue lands in the journal for you to break the tie.
8. Pass → opportunity moves to `awaiting_approval`. The draft package (CV docx + PDF + cover-letter.md + lint reports) lands at `state/pipeline/archive/<opportunity-id>/`.

### 5. Qualify (you, via Sheet or `/review-drafts`)

The Tray tab in your Google Sheet shows every `awaiting_approval` row with: company, title, score, top match reasons, red flags, CV variant chosen, first 2 sentences of the cover letter, link to the PDF, and two editable columns: **Action** and **Edits**.

- **On phone**: open the Sheet, tick `approve` / `reject` / `edit` / `hold` per row. Optional free-text in `Edits` ("shorten para 2", "use day rate $1400 not $1500").
- **At laptop**: invoke `/review-drafts` and walk rows interactively.

### 6. Submit

Two lanes. **Autopilot** (SEEK Quick Apply, LinkedIn Easy Apply) is step 5 of `/daily`: `npm run autopilot:submit` runs the letter-critic on the exact letter, walks the row to `approved`, runs the gate with `autopilot:<run-id>` provenance, drives the adapter, and records the confirmation. **Attended** covers everything else. `/submit-approved` is attended-only and is never fired by `/daily`:

1. `sheets-sync pull` reads the Tray's `Action` + `Edits` columns into `state/pipeline/approval-queue.json` and clears those cells.
2. Show the complete validated package and obtain fresh confirmation for that exact application. Leave every unconfirmed row in `manual_action_needed`.
3. For each freshly confirmed application, `submission-runner` enforces `state/profile/submission-policy.yaml`:
   - Hard gates: resume-lint-ats pass, slop ≤ warn, voice ≤ warn, rate set in profile, no red-flag blocker, dedup pass (pipeline + audit log).
   - Daily cap, per-channel rate limit and kill switch from `submission-policy.yaml` (see [Submission policy](#submission-policy--guardrails)).
4. Where the confirmed channel adapter is available and policy allows, submit while the user remains present. Halt and surface any new screening question or ambiguous result; never let an unattended wake retry it.
5. Everything else remains in `manual_action_needed` with the pre-filled CV and cover letter.
6. `edit` rows re-route to `/apply` with the user's edits as the brief; they bounce back to `awaiting_approval`.
7. `reject` rows move to `rejected`. Recurring patterns surface for the ignore-list.

### 7. Audit log (every step writes an event)

`tools/audit.ts` records every state change at `state/audit/audit-log.jsonl` (append-only). The cross-channel dedup index (`state/audit/dedup-index.json`) prevents re-applying to the same company + role-family within 60 days, even if the opportunity is posted on a different channel. Query:

- `npm run audit:summary -- --days 30` — totals by event type, distinct companies contacted, top recurring contacts.
- `npm run audit:query -- --type submitted --since 7d` — every submission this week with timestamps.
- `npm run audit:check-dup -- --company "Hays" --title "Solutions Architect"` — quick "have I already pursued this?" check (also runs automatically pre-submit).

### 8. Sheet mirror + journal

`state-syncer` runs after every mutation: pushes Pipeline + Tray + Followups + Contacts + Market tabs to Google Sheets, regenerates `state/pipeline/opportunities.md` (human-readable digest), and writes the day's `state/journal/YYYY-MM-DD.md`. The Sheet remains read-only mirror except for the two writable columns (`Action`, `Edits`) on the Tray tab.

### Skills you invoke explicitly (any time, in either CLI)

```
/daily            run the whole sequence above end-to-end
/hunt [channel]   step 1 only, for one or all channels
/review-drafts    step 5, synchronous (without the Sheet)
/submit-approved  step 6, on demand
/apply <opportunity-id>  step 6 for one specific opportunity, with explicit confirm
/manual-applications     walk manual_action_needed rows
/pipeline         status snapshot + audit recap
/follow-up        nudge submitted apps that haven't moved in N days
/prep-interview <opportunity-id>  research brief for an upcoming interview
/rate-check       market intel snapshot (median day-rate per role family)
/refresh-cv       re-parse your latest CV from cv_source_dir
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| LinkedIn scrapes hit a login wall | `npm run login:linkedin` — opens a browser, you log in once, cookies persist. |
| Sheet sync fails with 403 | Make sure the service-account email (from your JSON key) is shared on the Sheet as Editor. |
| PDF page count or image conversion fails | `brew install poppler`; verify `pdfinfo` and `pdftoppm` are on PATH. |
| PDF render fails or hangs | Presentation PDFs come from Playwright Chromium — run `npx playwright install chromium` if the browser is missing. |
| Launchd job not firing | `launchctl print "gui/$UID/com.job-hunt-harness.daily"` — check `last exit status` and `LastExitStatus`. Log lives in `state/journal/launchd/`. |
| `resume-lint-ats` failing on a real CV | Look at the lint report; most failures are about images, multi-column sections, or unrecognised section headings. Adjust the reference template or relax a rule. |
| Screening Q stuck | Add the answer to `state/profile/screening-answers.yaml` (or the corresponding Sheet tab) and re-run the daily job. |
| Submission failed | Check `state/pipeline/archive/<opportunity-id>/submission.log`. Common causes: stale storage-state cookies, portal HTML changed, screening Q added. |
| Voice/slop loop fails after 4 regen | The lint reports the persistent hit. Decide: relax the rule (edit `slop-banlist.md`), or hand-edit in the tray. |
| A saved SEEK job never went out | Check the row's `notes` in the Sheet or `npm run pipeline -- get --id <id>`. Legitimate reasons: the ad is not Quick Apply (external ATS), or an unknown screening question. A letter-critic block on a saved row is regenerated up to twice by the daily run; if it still blocks, the findings are in `notes` and `<archive>/letter-critic.json`. |
| Letter-critic blocks on a fact you changed in `cv-source.md` | The critic's standing rules in `state/profile/letter-critic-rules.yaml` and `state/profile/resume-editorial-rules.md` carry fixed framings for sensitive facts; update them together with the source, then re-render affected baselines. |
| `resume:audit` says `provenance: fail` with `source_hash` | `cv-source.md` or `profile.md` changed since the render. Re-render, or for a title-only tweak use `npm run resume:edit` and refresh the sidecar hashes. |
| Everything works attended, nothing happens at 07:00 | `HARNESS_CLI` unset in `.env` (`scripts/daily.sh` then defaults to `codex`), or the CLI binary is not on launchd's PATH. The first line of `state/journal/launchd/YYYY-MM-DD.log` names the CLI it resolved. |

## Developer onboarding

For someone changing the harness rather than running it. Read `AGENTS.md` first; it is the contract every agent operates under, and the tests assume it. `CLAUDE.md` is a one-line import of it.

### Mental model in five lines

1. **Agents reason, tools verify.** Judgement (classification, composition, drafting, critique) runs inside the CLI session as subagents under `agents/`. Everything mechanical (rendering, linting, gating, syncing, submitting) is a TypeScript tool under `tools/` with an `npm run` entry in `package.json`. If a check can be expressed as a rule, it is a tool and it has a test.
2. **`cv-source.md` is the only evidence.** CVs, letters and the critic may claim nothing that is not in it. `resume:term-grounding` and `letter-critic` enforce this; `market-confirmations.yaml` records what the user confirmed as familiarity versus delivered.
3. **Skills orchestrate, subagents produce, tools gate.** `.claude/skills/<name>/SKILL.md` is the user-facing workflow; it spawns subagents and calls tools in a fixed order. A skill never writes a production artefact inline.
4. **State is local; the Sheet is a mirror.** The SQLite store `state/pipeline/pipeline.db` and `state/audit/audit-log.jsonl` are the record (`opportunities.json` is only an export). `VALID_TRANSITIONS` in `tools/pipeline.ts` is the state machine (`docs/pipeline-state-machine.md`).
5. **Framework is generic, `state/profile/` is personal.** No name, employer, path or client detail goes into `tools/`, `agents/`, skills or templates. Anything that references the user is read from the profile at runtime.

### Where things live

```
agents/            subagent system prompts (Claude reads directly; .codex/agents/*.toml are generated)
.claude/skills/    workflows (/daily, /apply, /hunt, /resume-render ...); .agents/skills is a symlink for Codex
tools/             deterministic TypeScript; tools/resume/ is the CV pipeline, tools/channels/ the scrapers + submit adapters
templates/         resume renderers (classic/modern/minimalist/modern-columns) with rubric.yaml, cover-letter templates, report shell
tests/             tsx tests, one file per tool concern; `npm test` runs them all in sequence
scripts/           daily.sh (unattended orchestrator), install-launchd.sh, login-channel.ts, migrations
docs/              pipeline state machine, resume research claims (research → rubric → evaluate)
references/voice/  framework writing rules and slop banlist (not personal)
state/             everything per-user; see Privacy boundary
```

### Conventions that are enforced

- Resolve the repo root with `repoRoot()` from `tools/repo-root.ts` (or `bash .claude/hooks/repo-root.sh` in shell). Never trust `cwd`.
- Profile-scoped paths come from `resolveProfileContext()` in `tools/profile-context.ts`; `HARNESS_PROFILE=<id>` or `--profile <id>` switches to `state/profiles/<id>/`.
- Every tool prints one compact JSON object on stdout and exits non-zero on `fail`. Skills and agents parse that, they do not grep prose.
- Pipeline reads and mutations go through `tools/pipeline.ts` (`get`, `list`, `upsert`, `set-status`), which validates the transition and appends an audit event. Never read or write the `opportunities.json` export in a tool.
- Every send goes through `tools/submission-gate.ts`. New channel adapters (`tools/channels/<id>-submit.ts`) are dispatched by `tools/autopilot-submit.ts` and must return the same outcome shape (`submitted` / `needsManual` / `newScreeningQuestion` / error); add the channel to `autopilot.channels` only once its test exists.
- No em dashes or en dashes in generated content, ever (`voice-check` and the critic fail on them).
- Australian English in anything user-facing.
- Never run `git checkout` / `git restore` / `git stash` against `state/`; it holds uncommitted hand-curated work.
- After editing `agents/*.md`, run `npm run codex:sync-agents` so the Codex wrappers match.

### Typical change recipes

| Change | Touch | Prove it |
|---|---|---|
| New quality rule for CVs | `templates/resume/<t>/rubric.yaml` (mechanical) or `agents/resume-critic.md` (judgement); research claim in `docs/resume-research/claims.yaml` | `npm run resume:evaluate`, `tests/evaluate-core.test.ts` |
| New standing fact for letters | `state/profile/letter-critic-rules.yaml` (`standing_rules`, `never_named`, `profile_facts`) + `state/profile/resume-editorial-rules.md` (both, they must agree); the framework critic carries only generic rules | `tests/prompt-guardrails.test.ts`; run the critic on a known letter |
| New channel | `tools/channels/<id>.ts` implementing `HuntChannel`; optional `<id>-submit.ts`; `channels.yaml` entry | `tests/<id>-submit.test.ts` modelled on `seek-submit.test.ts` |
| New template | `npm run resume:template:new -- --name <n>`, then `render.ts`, `rubric.yaml`, `quality-checks.md`, `sample/` golden | `npm run resume:design:golden`, `npm run resume:templates:check` |
| New skill | `.claude/skills/<name>/SKILL.md` with frontmatter `name` + `description` (the description is the trigger) | `tests/prompt-guardrails.test.ts` (script names, banned phrases, dashes) |
| Gate change | `tools/submission-gate.ts` + `state/profile/submission-policy.yaml` shape | `tests/submission-gate.test.ts` |

### Running and debugging

```bash
npm test                                   # typecheck, then the whole suite
npm run typecheck                          # tsc --noEmit on its own
npx tsx tests/submission-gate.test.ts      # one file
npm run resume:audit -- --content-json <composition.json> --resume <id> --out-dir <dir>   # one render, every gate
npx tsx tools/letter-critic.ts --letter <cover-letter.md> --jd <jd.md>                     # critic on one letter
npm run autopilot:submit -- --id <opp-id> --run-id dev-$(date +%s) --dry-run              # walk the gate without sending
npm run pipeline -- get <opp-id>           # one row with history and notes
npm run pipeline:flush-discovered -- --older-than 14d --unclassified --apply   # clear the discovery tail (drop --apply for a dry run)
npm run letter:critic -- --digest --since 14d   # group recurring critic blocks into proposed standing rules
npm run archive:compact -- --apply              # shrink the archive (dedupe baseline CVs, recompress screenshots); dry run without --apply
```

The unattended run's full CLI transcript is `state/journal/launchd/YYYY-MM-DD.log` (JSONL). To see what a step returned, filter on the tool name rather than reading it top to bottom; it is several MB.

## Privacy boundary and open-sourcing

The framework is generic; the user's life is under `state/`. The published repository was started with a fresh history and every path below is `.gitignore`d, so a clone contains no person. Keep it that way in your fork: if you ever commit `state/`, do it on a private remote and never rebase that history onto a public one.

What must never be committed to a shared repo:

| Path | Contains | Handling |
|---|---|---|
| `state/channels/chrome-profile/**` | Live SEEK and LinkedIn browser sessions: cookies, tokens, local storage. **Account takeover material.** | `.gitignore`; rotate the sessions (log out, log in) if they were ever pushed |
| `state/channels/storage-state/*.json` | Playwright storage state (same risk) | already ignored |
| `state/profile/**`, `state/profiles/**` | Identity, phone, home address, date of birth, referees and their numbers, full CV, voice samples, rendered CVs, screening answers | ignore in a public fork; ship an `examples/profile/` skeleton instead |
| `state/pipeline/**` | Every job seen, every letter sent, confirmations, recruiter names, archived tailored CVs | ignore |
| `state/audit/**`, `state/journal/**` | Full audit trail and daily digests with letter text | ignore |
| `state/contacts/**`, `state/market/**`, `state/rejected/**` | Recruiter contacts, market intel, rejection notes | ignore |
| `state/org/team.yaml`, `state/org/team-report.html` | Team roster and rendered report | ignore or replace with the example |
| `.env` | Sheet credentials path and id | already ignored |
| `.playwright-mcp/` | Page snapshots from browser sessions | ignore |
| `templates/resume/_archived_*/sample/` | Old samples rendered from the owner's real CV | delete; current templates use the neutral `tests/fixtures/resume-content/senior-operator.json` |

Framework files use a placeholder person (`Jane Citizen`, `~/Documents/Resume/master-cv.docx`) wherever an example name or path is needed; the cover-letter sign-off reads `{first_name}` from `profile.md`.

Committed and generic: `state/org/resume-formats.yaml`, `state/org/resume-types.example.yaml`, `references/`, `templates/` (including `templates/profile/`, the neutral skeleton `setup:scaffold` copies), `docs/`. `tests/profile-template.test.ts` fails if any owner detail leaks into the skeleton.

## Architecture pointer

For the *why* behind every design decision (cross-CLI portability, async Sheet approval, screening-answer bank, the closed-loop CV refinement, anti-AI-slop, the submission guardrails), read `AGENTS.md` and the agent files in `agents/`. This README is the *how*; the agent files are the *what*; the plan in your fork's commit history is the *why*.
