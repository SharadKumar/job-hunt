---
name: resume-strategy
description: Review and adjust the profile's active resume positionings after onboarding. Use when the user wants to add, remove, rename, reprioritise, or reshape target resume strategies in state/profile/resumes.yaml, change search keywords, change target evidence hooks, alter cover-letter angles, or revisit whether the current market positionings still fit the CV and job market. Do not use for reviewing rendered resume artefacts; use resume-review for that.
---

# /resume-strategy: adjust resume strategy

This skill reviews `state/profile/resumes.yaml`, the strategy file that says which resume positionings the harness can credibly hunt and pitch.

It is distinct from:

- `/onboarding`: first-run creation of `resumes.yaml`.
- `/resume-review`: review and approval of rendered baseline resume artefacts.

## When This Runs

- The user wants to add or remove a resume positioning.
- The market has shifted and current search terms are noisy or stale.
- A target's `should`, `could`, `flagged`, `cover_letter_angle`, rate band, channels, or default template needs adjustment.
- A target needs explicit evidence weighting: which experiences to magnify, support, or de-emphasise for employer signal even though all are source-true.
- A target needs market-lens adjustment: expected employer signals, safe aliases, proof questions, or forbidden claims.
- Pipeline results show repeated false positives for one positioning.

## Inputs To Read

- `state/profile/resumes.yaml`
- `state/org/resume-types.yaml` when present: central resume type pool; profile entries are assignments/overrides.
- `state/profile/profile.md`
- `state/profile/cv-source.md`
- `state/profile/market-confirmations.yaml` when present: prior market-gap answers and suppressed questions
- `state/pipeline/opportunities.md` and recent classified opportunities when reviewing market fit
- `state/profile/resumes/<id>/editorial-rules.md` when a target has accumulated resume-edit feedback
- `references/market-lens-discovery.md` before creating or changing any `market_lens`

## Sequence

Resolve the repo root first (`references/harness/repo-root.md`).

Use structured-question mode when the review needs user judgement. Claude Code should use `AskUserQuestion`; Codex should use `request_user_input`. If the current mode cannot show structured questions, do not collect market-gap answers inline; pause after producing the gap list and tell the user to rerun the judgement step in structured-question mode.

1. Summarise current positionings:
   - id, label, active flag, template, channels, strongest evidence hook, evidence_strategy if present, and any obvious overlap with other positionings.
   - market_lens summary when present: must-signal list, aliases that may need source proof, and open proof questions.

2. Identify issues:
   - duplicate or overlapping targets
   - targets with weak CV evidence
   - search keywords that are too broad or too narrow
   - cover-letter angles that are too generic
   - evidence that is technically relevant but over-weighted for employer value, such as side projects crowding out commercial/client-facing proof
   - role-market terms the CV can support implicitly but does not name well
   - desirable role-market terms that need confirmation before use
   - default templates that do not fit the recipient culture

3. Run a market-discovery pass when the user names a strategic direction, domain, platform, tool, or role-market shift that is not already well represented in `market_lens`.
   - First read and follow `references/market-lens-discovery.md`.
   - Examples: "Claude Code", "applied AI", "AI engineering leadership", "agent platforms", "ServiceNow AI", "AI delivery governance".
   - Research current market expectations before editing the lens. Prefer primary or durable sources where available: official product docs, certification/exam blueprints, credible role descriptions, vendor implementation/adoption guides, recent job descriptions already in the pipeline, and high-signal market pages. Do not rely on stale model memory for fast-moving tools.
   - Generate queries from the CV/resume combo, not just the role title. Include the user's evidenced platforms, tools, domain, seniority, region, and suspected gaps.
   - Produce a compact capability map:
     - core capabilities employers are likely to expect
     - market terms and aliases recruiters/search systems use
     - concrete source evidence patterns that would make each term safe to use
     - proof questions for plausible but unconfirmed gaps
     - forbidden claims that should require explicit source proof
   - Filter candidate signals by market relevance, CV evidence proximity, resume value, and claim risk. Ignore generic filler even if common in resume-keyword pages.
   - Compare the capability map against `cv-source.md`. Classify each capability as `explicit`, `implicit`, `needs_confirmation`, or `missing`.
   - Update `market_lens.must_signal`, `keyword_aliases`, `proof_questions`, and `forbidden_claims` from that comparison. `acceptable_if_source_mentions` must contain source-specific evidence patterns, not generic terms. Do not put person-specific achievements in the central role type; only put market expectations and safe-use rules there.
   - If org mode is present, centralise reusable role-market expectations in `state/org/resume-types.yaml`; keep person-specific overrides or assignments in the profile's `resumes.yaml`.

3b. Cloud refresh, the standing market research step, not an optional extra.

   **You refresh a CLOUD, not a type.** Keyword clouds live once in `state/org/keyword-clouds.yaml`: capability clouds (`agentic-engineering`, `enterprise-architecture`, `programme-delivery`, …), domain clouds (`financial-services-lending`, `nsw-government`, …) and tooling clouds (`claude-and-anthropic`, `azure-and-microsoft-ai`, …). A resume type does not own vocabulary; it references clouds with a weight:

   ```yaml
   market_lens:
     clouds:
       - id: agentic-engineering
         weight: 5          # 1-5, how central this cloud is to the positioning
       - id: evals-and-release-gating
         weight: 5
   ```

   So refreshing one cloud moves **every positioning that references it** at once. Before you refresh, say which types are affected (grep `state/org/resume-types.yaml` for the cloud id) and check the weight each gives it, because a cloud that is weight 5 somewhere deserves more care than one that is weight 2 everywhere. Conversely, never fix a gap for one positioning by forking a term into a second cloud: a term belongs to exactly one cloud, and the validator enforces it.

   Every positioning is written against current clouds; `/resume-render`, `/resume-review` and `/apply`'s tailored path all refuse to render without them, and `npm run resume:audit` fails the `gates.clouds` check when a positioning references none, warning when a load-bearing cloud (weight >= 4) is older than 30 days. Refreshed monthly, and on demand whenever a positioning changes, the user asks, or `npm run resume-types:validate` warns that a cloud is stale.

   The shape of the research is always the same, and it starts from the title, not from the CV:
   - **Start at the title family.** Take the positioning's title and its near neighbours (the titles the same adverts use interchangeably) as the seed. The market's vocabulary belongs to the role, not to this person.
   - **Mine local JDs first,** then the web. The local pipeline is the cheapest and most current evidence of what this market actually asks for; the web pass fills what the local corpus is too thin to settle.
   - **Build the keyword cloud**: the ranked set of terms, aliases and categories that the title family's adverts and screeners actually use.
   - **Qualify every term against `cv-source.md`.** Each term lands in exactly one tier: `corpus` (evidenced), `preppable` (familiarity only), `confirm` (plausible but unevidenced), `forbidden` (never claim).
   - **Hand the unmatched-but-important terms to the evidence interview** in 3c. A term the market wants and the corpus lacks is a question for the user, never a silent drop and never a fabricated claim.
   - Prerequisite: the local JD corpus is thin (most pipeline rows carry only a search-card teaser). In an attended session with Chrome available, first run `npm run seek:enrich -- --status any --min-score 60 --limit 30 --resume <resume-id>` so the top rows for this type carry full adverts. Skip this in headless runs.
   - Run `npm run lexicon:mine -- --resume <resume-id> --json`. It mines the local JD corpus (pipeline descriptions of 500+ chars, `state/pipeline/archive/*/jd.md`, and every matching title) for 1-3 word terms ranked by document frequency and must-have frequency, and marks each as `present` or `absent` in `cv-source.md`. Each mined term carries a `suggested_cloud` (nearest cloud by token overlap) and the table output is grouped by cloud, so the candidates arrive already sorted into the clouds that would own them. Treat the suggestion as a prompt, not a decision. It also reports how many full JDs it had; when that count is under 10, treat the ranking as indicative and lean on the web pass below.
   - Present the candidates in grouped batches of at most 4 options: "accept these N corpus-backed terms", "review N preppable terms", "review N needs-confirm terms", "these N are forbidden unless sourced". The user can trim any group.
   - Run the `references/market-lens-discovery.md` web pass only for high-frequency terms with weak local evidence, and for terms the local corpus under-represents. Do not re-research terms the local corpus already settles.
   - Write the result into the owning cloud in `state/org/keyword-clouds.yaml`: bump that cloud's `refreshed_at` and `source_summary`, and add or amend `terms[]` (`term`, `aliases`, `category`, `tier: corpus | preppable | confirm | forbidden`, `why`, `evidence_patterns`, `jd_frequency`, `source`). A term belongs to exactly one cloud; if it is already in another cloud, amend it there instead of adding a second copy. A `forbidden` term needs a `why` saying what the block protects against; the cloud is the authority, and every type referencing it inherits the block, so it does not need mirroring into each type's `forbidden_claims`. If the positioning needs a cloud that does not exist yet, create the cloud (id, `kind`, `label`, `description`) and then reference it with a weight from the type. Then run `npm run resume-types:validate`.

3c. Evidence interview (standing gap-filling; runs at the end of every cloud refresh):
   - The user has done far more than `cv-source.md` records, so a term the market wants and the corpus lacks is usually missing evidence, not a missing skill. Turn the clouds' `confirm` tier and any `must_signal` gaps into questions immediately rather than leaving them as pending rows.
   - The keyword plan already groups and orders its `questions[]` by cloud weight then JD frequency, so work through them cloud by cloud: name the cloud, ask its questions, then move to the next. The four fixed answers, what each one means, and how to record and patch each one are in `references/harness/keyword-answers.md`; follow it rather than re-deriving it here. Each question names the term, the roles where it plausibly occurred, why the market wants it (the cloud term's `why`), and a proposed one-line phrasing.
   - When the refresh was triggered by a render that stopped on a missing or stale cloud, return to that render only after 3b and 3c have both completed for the positioning.

4. Apply confirmation memory before asking the user:
   - If `market-confirmations.yaml` says a signal was already `confirmed`, do not ask again. Require the confirmed fact to be added to `cv-source.md` before any resume can render it.
   - If a signal was `declined` or `not_applicable`, suppress it unless the user explicitly reopens the topic or the market lens materially changes.
   - If a signal is `pending`, surface it as an outstanding action, not as a fresh question.
   - Do not treat prior composition JSON as source truth. It can help audit what happened last time; it cannot prove a claim.

5. Propose concrete changes:
   - add / deactivate / rename / merge positionings
   - update keywords
   - update `should`, `could`, or `flagged`
   - update `cover_letter_angle`
   - update `evidence_strategy.employer_signal_lens`, `magnify`, `support`, or `de_emphasize`
   - update `market_lens.must_signal`, `keyword_aliases`, `proof_questions`, or `forbidden_claims`
   - update default template

6. Ask for approval before writing:
   - Use the active CLI's structured question tool when available: Claude Code `AskUserQuestion`, Codex `request_user_input`.
   - If multiple changes are independent, group them into one concise proposal.
   - For evidence-gap questions, ask only precise, source-updating questions with the four fixed answers (`references/harness/keyword-answers.md`). Example: "For Claude Code work, did you define reusable slash commands/subagents/hooks that governed delivery, or was use limited to ad-hoc coding assistance?"

7. Apply approved edits to `state/profile/resumes.yaml` or `state/org/resume-types.yaml`, depending on whether the change is profile-specific or central.
   - When the user answers an evidence-gap question, record it in `market-confirmations.yaml`.
   - If the answer confirms a usable fact, update `cv-source.md` before expecting `resume-writer` to render it.

8. After any edit, tell the user which follow-up is required:
   - `/resume-review` if target content or template changed
   - pipeline rescore if matching criteria changed
   - re-hunt if search keywords or preferred channels changed

## Boundaries

- Do not edit rendered resume files here.
- Do not approve baselines here.
- Do not invent evidence. If a positioning is desirable but weakly supported, mark it as a stretch and surface the evidence gap.
- Keep source truth and evidence weighting separate: source says what happened; `evidence_strategy` says how much visible weight that evidence should carry for this target.
- Keep market language evidence-gated: `market_lens` can say what employers expect, but `resume-writer` may only render terms supported by source provenance. Confirmation answers must update `cv-source.md` before use.
- Do not make every render a research task. Research happens here when the positioning changes, the user asks for a refresh, or a load-bearing cloud is older than 30 days. Renders consume the current lens and clouds; they never research.
- Keep `resumes.yaml` profile-specific. Resume templates remain reusable harness-level assets under `templates/resume/`.
