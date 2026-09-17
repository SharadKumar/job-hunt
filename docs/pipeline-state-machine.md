# Pipeline state machine

Source of truth: `VALID_TRANSITIONS` in `tools/pipeline.ts`. `npm run pipeline -- set-status` refuses any move not listed here and exits non-zero. This page explains what each status means, who is allowed to move a row into it, and what the row looks like while it sits there.

## The queue in one line

`discovered` → `shortlisted` → `drafted` → `awaiting_approval` → `approved` → `submission_pending` → `submitted` → `responded` → `interview` → `offered` → `won`

Anything not on that line is a hold (`parked`, `awaiting_external`, `manual_action_needed`) or an exit (`rejected`, `withdrawn`).

## Statuses

| Status | Meaning | Who moves a row here | Required fields |
|---|---|---|---|
| `discovered` | Imported from a channel. Scored, but not in the queue: below the shortlist line, blocked by a red flag, or no resume positioning fits. | `hunt` upsert; `pipeline:rescore` (demotion) | `score`, `classification` (agent) |
| `shortlisted` | **The apply queue.** Agent-classified, score ≥ `shortlist_min_score`, no blocker, a resume positioning fits, and the role is doable from the home city (Sydney/NSW/remote, or interstate with `location_flexibility` remote/flexible). Every row here is meant to be applied to unless a human records a concrete reason. | `pipeline:rescore` only (agent classification required) | `classification.matched_resume_id`, `classification.discipline_fit` ∈ {core, platform_gap} |
| `parked` | Fits the profile but held for a logistics reason the user has ruled on: an interstate role that needs routine onsite attendance, or an interstate role whose ad is a card-only blurb so flexibility is unknown. Not part of the queue. Re-enters `shortlisted` if the ad turns out remote/flexible. | `pipeline:rescore` (when `score.ts` returns `parked_reason`); attended user decision | `parkedReason` |
| `awaiting_external` | Waiting on something outside the harness (e.g. a recruiter reply that decides whether to proceed). | attended session | reason in history |
| `drafted` | Package assembled in `state/pipeline/archive/<id>/`: JD, keyword plan, CV (baseline or tailored), cover letter, metadata. Not yet reviewed. | `/apply`, daily orchestrator | archive dir |
| `awaiting_approval` | Package complete and shown in the Sheet Tray. An `approve` in the Tray authorises preparation only, never submission. | `/apply`, daily orchestrator | Tray row |
| `approved` | User approved the package. Still not submitted. | Tray pull (`sheets:pull`), attended session | `approvedAt` |
| `submission_pending` | A submission is in progress (form partly filled, external ATS mid-flow, or the autopilot adapter driving SEEK Quick Apply). | `submission-runner`, attended session, `autopilot-submit` | |
| `submitted` | Confirmed sent: success page text or ATS confirmation recorded in `archive/<id>/confirmation.txt`. Attended sessions, or SEEK Quick Apply on autopilot (see below). | attended session, `submission-runner` (attended), `tools/autopilot-submit.ts` (SEEK only) | `submittedAt`, `confirmation.txt`, `resumeId`; autopilot adds `letter-critic.json` and an audit `submitted` event with actor `autopilot` |
| `manual_action_needed` | The harness cannot finish it (account portal, native file picker, personal data fields, letter-critic block, gate failure, unknown screening question). Checklist written to `archive/<id>/manual-checklist.md` where applicable; the reason is in `notes`; the user completes it and reports back. | `/apply`, `submission-runner`, daily orchestrator, `autopilot-submit` | `manual-checklist.md` or a `notes` reason |
| `responded` / `interview` / `offered` / `won` | Post-submission progress, recorded by the user or `/follow-up`. | attended session | |
| `rejected` | Exit (user may reopen to `discovered`). Harness or user decided not to pursue, with a reason: hard skill gap, fixed-term/PAYG, mandatory clearance, duplicate requisition, seniority mismatch, or employer decline after submission. | any attended flow; `pipeline:rescore` never rejects | reason in history |
| `withdrawn` | Exit (user may reopen to `discovered`). Listing gone, or the user pulled out (e.g. another agency represents the same requisition). | attended session | reason in history |

## Transitions

```
discovered          → shortlisted | parked | awaiting_external | rejected | manual_action_needed
awaiting_external   → shortlisted | rejected | withdrawn
shortlisted         → drafted | parked | rejected | withdrawn
parked              → shortlisted | discovered | rejected | withdrawn
drafted             → awaiting_approval | rejected | withdrawn
awaiting_approval   → approved | rejected | withdrawn | manual_action_needed
approved            → submission_pending | submitted | manual_action_needed | withdrawn
submission_pending  → submitted | manual_action_needed | withdrawn
manual_action_needed→ approved (retry once the blocker is cleared) | submitted | rejected | withdrawn
submitted           → responded | rejected | withdrawn
responded           → interview | rejected | withdrawn
interview           → offered | rejected | withdrawn
offered             → won | rejected | withdrawn
won                 → (terminal)
rejected | withdrawn→ discovered   (user reopen only; the row must earn shortlisted again)
```

`pipeline:rescore` may only move rows between `discovered`, `shortlisted` and `parked` (and re-score `drafted` / `awaiting_approval` with `--all` without changing status). It never rejects, withdraws or submits.

An attended submission that starts from `shortlisted` must walk `drafted → awaiting_approval → approved → submitted`; helper scripts must not skip steps, and must surface a non-zero exit rather than swallow it (2026-09-14 incident: four confirmed submissions sat at `shortlisted` because a helper grepped the error away).

## How a row earns `shortlisted`

Computed in `tools/score.ts` and applied by `tools/rescore-pipeline.ts`:

1. Classification is agent-sourced (`_classifier: "agent"`); regex triage never promotes.
2. `discipline_fit` caps `profile_relevance`: outside ≤ 25, adjacent ≤ 54, platform_gap ≤ 74.
3. `score = 0.65 × relevance + 0.35 × base` (base = arrangement, rate, recency, tag overlap, seniority, bonuses, penalties). Relevance < 50 caps the score at 40; any blocker caps it at 30.
4. Blockers: onsite 5 days, junior/mid, exclusive, PAYG-only, permanent/fixed-term, relevance < 25, or no `matched_resume_id`.
5. A row with `userSaved: true` (saved by the user on SEEK) is always `shortlisted`; the gate applies only the hard employment blocks at send time. Otherwise `score ≥ 55` and no blocker → `shortlisted`, unless the role is interstate and `location_flexibility` is `onsite` or `unknown`, in which case → `parked` with `parkedReason`.

## Autopilot (SEEK Quick Apply, unattended)

User decision 2026-09-15: `/daily` may move a SEEK row to `submitted` without a human reading the package. The only tool allowed to do that is `tools/autopilot-submit.ts` (`npm run autopilot:submit -- --id <id> --run-id daily-<date>`). It walks `drafted → awaiting_approval → approved` through `setStatus`, then `approved → submission_pending → submitted` only after both of these hold:

1. `archive/<id>/letter-critic.json` is a `pass` from `tools/letter-critic.ts` whose `letter_sha256` matches the current `cover-letter.md` (a cold fact-check against `cv-source.md`; any unsupported claim, misattribution, dash or confidentiality breach is a `fail` and blocks).
2. `tools/submission-gate.ts` returns `submit` for provenance `autopilot:<run-id>`: `autopilot.enabled` in `submission-policy.yaml`, status `approved`, `classification._classifier: "agent"`, `userSaved: true` or (`discipline_fit: core` and not an interstate onsite/unknown row), no `red_flag_blocker`, channel `seek` opted in and listed in `autopilot.channels`, kill switch off, both daily caps open.

Evidence a row must carry after an autopilot send: `archive/<id>/confirmation.txt` (channel, SEEK job id, confirmation text, resume filename, letter sha, run id, timestamp), the adapter's success screenshot in the archive, `letter-critic.json`, an audit `submitted` event with `actor: "autopilot"` and `details.run_id`, and the full letter text under "Sent unattended" in that day's journal. A user-saved row is also unsaved on SEEK (`npm run seek:unsave`).

Any other outcome (letter-critic block, gate `gate_failed` / `manual` / `duplicate`, external-ATS redirect, unknown screening question, adapter failure) moves the row to `manual_action_needed` with the reason in `notes`. Gate `blocked` (kill switch) or `capped` leaves the row at `approved` for a later run. LinkedIn Easy Apply rows (`channel: linkedin_jobs`, `applyMethod: easy_apply`) take the same autopilot path once `linkedin_jobs` is in `autopilot.channels`; LinkedIn ads with any other apply method go to `manual_action_needed`. Rows on every other channel still reach `submitted` only through an attended session.

## Sheet

The Pipeline tab orders rows awaiting_approval, approved, submission_pending, shortlisted, parked, then the rest, and shows `disciplineFit`, `location`, `locationFlex` and `locationFlexQuote` so a parked row explains itself. Only rows with `score ≥ pipeline_sheet_min_score` (40) or a non-discovered status are pushed.

The `Summary` tab is written by `tools/daily-summary.ts` (`npm run daily:summary`, the last step of `/daily`): one row per line of that day's `state/journal/summary/<date>.md`, columns `date`, `section`, `line`, cleared and rewritten each run with the latest date at the top. It is a read-only morning brief (sent today, escalations with the next action, queue and parked, responses, numbers); nothing in it is pulled back.
