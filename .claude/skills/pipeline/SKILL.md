---
name: pipeline
description: Show the current state of the job pipeline — counts by status, top scoring items per actionable bucket, recent activity, channel health. Use when the user asks "what's in the pipeline", "show pipeline status", "where are we at", "what needs my attention", "any new responses", "anything stuck". Read-only snapshot.
---

# /pipeline — status snapshot

Quick read-out of where the harness is at right now.

## What to do

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

1. `npm run pipeline -- summary` — totals by status.
2. For the actionable statuses (`awaiting_approval`, `manual_action_needed`, `responded`, `interview`), `npm run pipeline -- get --status <status>` and surface the top 5 by score per status.
3. **Audit recap**: `npm run audit:summary -- --days 7` — submissions in the last week, distinct companies contacted, top recurring contacts.
4. **Duplicate watch**: list any rows in `awaiting_approval` whose `company + title` fingerprint already has a submitted/responded event in the audit log within 60 days. Surface these for user attention — they're likely re-postings of roles already in flight.
5. Recent activity: parse `state/journal/` for today and yesterday; surface anything notable.
6. Channel health: scan recent journal entries for channels that failed or returned 0 results unexpectedly.

## Surface

Short, scannable:
```
PIPELINE  N total
  awaiting_approval: 3   (top: Solutions Architect @ NSW Gov, score 82)
  approved: 1            (queued for next /submit-approved)
  submission_pending: 0
  submitted: 12          (oldest: 9 days ago — consider /follow-up)
  responded: 2           (one interview offer — see archive)
  manual_action_needed: 4

CHANNELS
  seek: 5 new in last 24h
  linkedin_jobs: STUB (not yet implemented)
  hays: STUB

RECENT
  - 2 drafts queued overnight
  - LinkedIn login expired → re-run npm run login:linkedin
```

## When to ask

Read-only. No questions needed. If something concerning shows up (e.g., 10+ manual_action_needed building up), surface a recommendation, don't ask — the user can act on it next time.

## Boundaries

- Pure read. Never mutates state.
