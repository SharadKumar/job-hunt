# Editorial instruction capture (#10, the learning loop)

Shared procedure used by both `/resume-render` and `/resume-review` skills. When the user edits a baseline before approving (or rejects a resume-writer suggestion), treat the feedback as a routing signal and materialise it into the narrowest durable instruction home that will improve future output. Do not maintain a separate feedback ledger when the instruction can be captured directly in source, profile rules, resume rules, or template code/rubric.

## When this fires

- User picks "Edit before approving" from the post-render AskUserQuestion.
- User manually edits the rendered docx/pdf outside the harness, then comes back to approve a different version (skill can detect the diff).
- User picks "Re-render with different composition" with specific edit guidance ("drop the EY block", "shorten the summary").
- User rejects the baseline outright ("this composition is wrong; redo").

## Route before writing

Classify every edit before applying it:

| Route | Use when | Durable home |
|---|---|---|
| Source-level | The fact/evidence is missing, wrong, stale, or newly available | Master CV via `/refresh-cv`, or `state/profile/cv-source.md` for surgical local edits |
| Profile-level | The preference should apply to this user's resumes across positionings | `state/profile/resume-editorial-rules.md`, `references/voice/slop-banlist.md`, or `references/voice/voice-rules.md` |
| Resume-level | The preference applies only to this resume/positioning | `state/profile/resumes/<resume-id>/editorial-rules.md` |
| Positioning evidence-weight | The feedback says true source evidence is over- or under-weighted for this resume's employers | `state/profile/resumes.yaml` → resume `evidence_strategy` |
| Template-level | The issue is layout, typography, heading policy, page budget, density, or rendering behaviour reusable across profiles | `templates/resume/<template>/styles.css`, `rubric.yaml`, `quality-checks.md`, `template.md`, or renderer code |

Harness-level template changes must be profile-neutral. If the instruction depends on this user's career story or go-to-market strategy, it is profile-level or resume-level, not template-level.

## What gets captured

For resume-level changes, store minimal instructions that resume-writer can read and act on. Each entry is one line plus a brief reason. Append to `state/profile/resumes/<resume-id>/editorial-rules.md`.

For evidence weighting changes, update `state/profile/resumes.yaml` directly instead of appending another editorial note. Use `evidence_strategy.magnify`, `support`, and `de_emphasize` to encode how much visible weight a true experience should carry for this resume. Example: a technically relevant side project may be `support` or `de_emphasize` if employers value commercial client work more.

For profile-level resume preferences, store the same style of minimal instruction in `state/profile/resume-editorial-rules.md`. That file belongs to this user's profile and should not be copied into the reusable harness.

For template-level changes, change the template artifact directly and update its rubric/quality checks when the rule should be enforced. Do not create an extra "feedback record" once the template has been improved.

### Entry formats

| Pattern | Format | Example |
|---|---|---|
| Bullet removed | `<ISO-date>  bullet-removed  "<text>"  (<reason>)` | `2026-05-30  bullet-removed  "leveraged transformational change"  (slop phrase)` |
| Experience demoted | `<ISO-date>  experience-demoted  <id>  (<reason>)` | `2026-05-30  experience-demoted  2021-03_ernst-young  (EA target should lead with hands-on delivery, not pure-advisory)` |
| Experience promoted | `<ISO-date>  experience-promoted  <id>  (<reason>)` | `2026-05-30  experience-promoted  2022-04_apl  (user wants Next.js/full-stack signal stronger on EA)` |
| Summary edited | `<ISO-date>  summary-edited  "<delta>"  (<reason>)` | `2026-05-30  summary-edited  "lead with GenAI prototype" → "lead with ServiceNow ESM transformation"  (user prefers programme-first framing)` |
| Phrase removed (per-resume) | `<ISO-date>  phrase-removed  "<text>"  (<reason>)` | `2026-05-30  phrase-removed  "trusted advisor"  (overused; treat as per-resume slop on EA)` |
| Skill block removed | `<ISO-date>  skill-removed  "<name>"  (<reason>)` | `2026-05-30  skill-removed  "Agile"  (not relevant for EA architecture pitch)` |

Reasons are short: one clause. They give resume-writer context for edge-case judgement.

## Procedure

### 1. Ask the user what changed

Use AskUserQuestion (max 4 options). Examples:

```
Question: "What did you change in this baseline?"
Options:
  - Removed a bullet (and which one)
  - Demoted/dropped an experience
  - Edited the summary
  - Removed/changed a phrase across the CV
  - Multiple things (describe in free text)
```

For multi-thing edits or unstructured edits, fall back to "Other" with a short free-text capture.

### 2. Materialise the instruction

Resume-only path: `state/profile/resumes/<resume-id>/editorial-rules.md`.

Profile-wide path: `state/profile/resume-editorial-rules.md`.

If the target-level file doesn't exist, create it with a header:
```markdown
# Editorial rules: <resume-id>

resume-writer reads this file before composing for this resume. Each line below
captures an edit the user made to a prior render. resume-writer treats them as
soft preferences, and strong resume-fit can override, but the writer should
surface conflicts rather than ignore them silently.

Append-only. Skills are the only writer.
```

Append each new entry as a single line below the header.

If the profile-level file doesn't exist, create it with this header:
```markdown
# Profile resume editorial rules

resume-writer reads this file before composing any resume for this profile.
These are durable profile-specific preferences, not reusable harness rules.

Append-only unless the user explicitly asks to revise or remove a rule.
```

For source-level changes, do not write an editorial rule if the source can be corrected now. Update the master CV/source, then re-render so provenance reflects the corrected source.

For template-level changes, patch the template/rubric/quality-check file directly and run the relevant render/evaluate checks. If a template issue is discovered from this user's resume but applies generically to that template, it belongs in `templates/resume/<template>/`, not in profile state.

### 3. Detect threshold crossing: promotion to wider scope

If the same pattern appears twice within 7 days (e.g., the same phrase removed in two different per-resume rules files, OR removed twice from the SAME resume's rules file), surface to the user:

```
Question: "You've removed the phrase 'leveraged transformational change' twice this week.
           Promote to global slop-banlist (applies everywhere) or keep per-resume only?"
Options:
  - Promote to global slop-banlist (recommended for clear slop)
  - Keep per-resume only (the phrase might be fine elsewhere)
  - Don't ask me again about this phrase
```

On "promote to global": append to `references/voice/slop-banlist.md` with a brief reason, or patch the relevant template if the issue is visual/layout/rubric. On "per-resume only": do nothing (the per-resume entry already exists). On "profile only": move or copy the instruction to `state/profile/resume-editorial-rules.md`. On "don't ask": record a suppression note in the narrowest relevant instruction file.

### 4. resume-writer reads, doesn't write

resume-writer's operating contract reads editorial-rules.md as input. It NEVER writes to it. Only the skill writes. This keeps the editorial accumulation auditable and confined to the user-interaction surface.

## What this guards against

- Manual banlist/voice-rules maintenance becoming a chore the user abandons
- The harness producing the same slop pattern over and over because the lesson never landed
- Per-resume preferences getting accidentally globalised before they've proven out

## What this does NOT do

- Doesn't keep a separate raw feedback log when the instruction has been materialised.
- Doesn't turn profile-specific preferences into reusable harness/template rules.
- Doesn't auto-promote without asking. Promotion to global slop-banlist is always user-confirmed.
- Doesn't backfill historical edits. Starts from when the skill begins capturing.
