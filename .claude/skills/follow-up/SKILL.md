---
name: follow-up
description: Surface submitted applications that haven't moved in N days (default 7) and draft polite nudges. Use when the user asks "any follow-ups due", "chase up old applications", "what hasn't responded", "clean up stale apps", or "send a nudge for X". Drafts only, never auto-sends; recruiter emails go to Gmail drafts and LinkedIn DMs stay in the tray. Arg: `[--days=N]`.
---

# /follow-up: clear stale applications

Submitted roles that haven't moved in N days are silent dead-ends most of the time, but occasionally a polite nudge revives one.

## What to do

Resolve the repo root first (`references/harness/repo-root.md`).

1. `npm run pipeline -- get --status submitted` and filter to `submittedAt` older than N days, no `responseAt`.
2. For each row:
   - Show: role, company, days since submitted, channel, the recruiter/HM contact if known (from `state/contacts/`).
   - Ask via `AskUserQuestion`: "Draft a follow-up email to the recruiter / Draft a LinkedIn DM to the HM / Mark as cold (no reply) / Skip for now?"
   - For draft options: invoke `cover-letter-writer` in follow-up mode (it owns nudge-message authoring per its contract: a 3-line message in the user's voice, referencing the original application date). It routes through slop-killer + voice-check before returning.
   - For "cold": set status `→ rejected` with reason "no response after N days".
3. Drafts land in Gmail drafts (recruiter email) or in `state/pipeline/outreach/<opportunity-id>/follow-up-dm.md` (LinkedIn).
4. `state-syncer` mirrors.

## When to ask

- > 10 stale rows → ask: "Walk all / top 5 by original score / just the ones at recruiters you've placed with before?"
- An unanswered application after a phone screen happened (visible in archive notes) → ask: "Standard follow-up (recommended) / firmer ask for status / withdraw and move on?"

## Boundaries

- Don't auto-send anything. Drafts go to Gmail drafts; LinkedIn DMs stay in the tray.
- One follow-up per submission max; don't pester. After a second follow-up draft was already sent (visible in archive), mark cold automatically.
