# Keyword and market-lens answers

`AGENTS.md` section 9 is the rule; this page carries the wording and the semantics so skills can link instead of restating them.

Every keyword or market-lens confirmation is asked with exactly these four answers, recommended first:

- `Confirm and update source (Recommended)`
- `Bring in as familiarity`
- `Not applicable`
- `Unsure / keep pending`

Ask in batches of at most 4 through the structured question tool (`AskUserQuestion` in Claude Code, `request_user_input` in Codex). Question text is the row's `question` plus its `evidence_hint` (the roles where the term plausibly occurred) and its `why` (what the market wants it for). The answer is a yes or no plus optional detail, never an open "tell me about X". Dedupe questions sharing an `alias_group`, and ask one question per term even when several opportunities queued it.

Record every answer with `npm run resume:keyword-confirm -- record --plan <plan-path> --term "<term>" --status confirmed|not_applicable|familiarity|pending --origin attended`. Never hand-edit `market-confirmations.yaml`.

What each answer means:

- **Confirm and update source.** The fact is real but the corpus lacks it. A confirmed row authorises nothing until the fact is written into `cv-source.md`: show the proposed one-bullet patch (`proposed_phrasing`) at the role in `evidence_hint`, ask `Apply this wording (Recommended)` / `Edit wording` / `Skip`, and on Apply or Edit run `npm run resume:keyword-confirm -- apply-patch --term "<term>" --resume <resume-id> --role-heading "<heading substring>" --bullet "<final text>"` (add `--skills` for a Skills-section fact). On Skip the row stays `confirmed` but unrenderable. The master `.docx` must carry the same fact or `/refresh-cv` drops it.
- **Bring in as familiarity.** The person did not deliver it but can credibly prepare and speak to it. Recorded as `--status familiarity`, no source patch. The re-run plan marks it `preppable` with `render_as: "familiarity"`, so `resume-writer` renders it once in a familiarity-framed skills line ("Familiar with ...", "Working knowledge of ...", "Prepared on ...") and lists it under `interview_prep_terms`, never as delivered work and never in the screener block. It is answered, so it is never re-asked.
- **Not applicable.** Suppresses the term permanently.
- **Unsure / keep pending.** Leaves a `pending` row that `/resume-review` and `/review-drafts` offer again. Do not re-ask it in the same run, and render without it.

Unattended runs never ask: `npm run resume:keyword-confirm -- queue --plan <plan-path> --origin daily` records the questions as `pending` and the render proceeds without those terms.
