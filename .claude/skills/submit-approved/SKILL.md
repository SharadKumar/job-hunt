---
name: submit-approved
description: In an attended session, pull the user's Sheet decisions, show the exact validated application packages, obtain fresh confirmation for each external submission, and then invoke the submission runner only for those confirmed applications. Never runs as part of an unattended routine.
---

# /submit-approved — drain the approved-row queue

Reconcile the user's Sheet decisions and, while the user is present, submit only the exact application packages they freshly confirm at the action point. A prior Sheet approval authorizes preparation, not submission.

## What to do

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

1. Invoke `state-syncer` with `--pull-first` to run `npm run sheets:pull` (reads Tray `Action` + `Edits` into `state/pipeline/approval-queue.json` and clears the cells).
2. Show each complete validated package proposed for external submission and obtain a fresh attended confirmation naming that exact application. Leave every unconfirmed row in `manual_action_needed`.
3. Invoke `submission-runner` only for the exact applications confirmed in this attended session. It still honours `submission-policy.yaml` end-to-end (kill switch, per-channel opt-in, daily cap, validation gate).
4. Invoke `state-syncer` (without `--pull-first`) to push the new state to the Sheet.

## Surface to the user

- N rows actioned (approve/edit/reject/hold breakdown).
- N submitted, N to manual queue, N held for missing screening answers, N hit the daily cap.
- Any new screening questions queued for them to answer.
- Anything that failed and why.

## When to ask

- Sheet queue is empty (no Action/Edits ticked) → ask: "Pull again in case Sheet pull just missed it / show current `awaiting_approval` so you can mark in the tray instead / abort?"
- About to hit the daily cap mid-queue → ask: "Submit up to the cap and queue the rest for tomorrow / raise the cap temporarily / pause so you can prioritise which to submit?"

## Boundaries

- Never bypass the kill switch.
- Never run this skill headlessly, from a scheduler, or without the user present.
- Never treat Sheet approval, channel opt-in, or a passing gate as external-action authority.
- Never submit recruiter-email channels (those write Gmail drafts for the user to send themselves).
- If a row's hard gates fail (lint, slop, missing rate, dedup), route to `manual_action_needed` with the reason in `notes` — don't try to fix on the fly.
