---
name: manual-applications
description: Walk applications that the harness couldn't auto-submit (recruiter email, unsupported portals, Easy-Apply variants without adapters) and help the user finalise them in their browser. Use when the user asks "what's in manual", "finish my manual queue", "any applications I need to send myself", or "walk me through the ones I have to submit by hand".
---

# /manual-applications: finish the applications the harness couldn't auto-submit

Some channels (recruiter email, unsupported portals, Easy-Apply variations the adapter doesn't handle) end up in `manual_action_needed`. This walks them so the user can finish in their browser in seconds.

## What to do

Resolve the repo root first (`references/harness/repo-root.md`).

1. `npm run pipeline -- get --status manual_action_needed`.
2. For each row:
   - Start a wall-clock timer and load `submission-policy.yaml → application_efficiency`.
   - Show: opportunity title, company, channel, URL, why it's manual, the path to the prepared CV (PDF), the path to the cover letter (.md), and (if recruiter email) the Gmail draft URL.
   - Walk the user through: open URL, paste cover letter, attach CV, answer any screening questions (refer them to `state/profile/screening-answers.yaml`).
   - Aim to finish within `target_minutes_per_application`. For an external portal, stop at `external_portal_hard_stop_minutes`; leave the row in `manual_action_needed` with the exact blocker rather than spending the rest of the batch on one form.
   - Ask via `AskUserQuestion`: "Submitted / Skipped (not the right opportunity) / Hold (will do later)?"
   - If Submitted: capture the confirmation number/URL if the user has it, set status `→ submitted`, record `submittedAt`.
   - If Skipped: status `→ rejected` (with reason "manual review changed mind").
   - If Hold: leave it, ask if they want to surface it again tomorrow.
   - Record elapsed seconds, budget, and outcome in the audit event's `details` when `record_timing_in_audit` is true.
3. `state-syncer` mirrors.

## When to ask

- > 5 rows in the queue → ask: "Walk all / top 3 by score / filter by channel?"
- A shared buyer/RFQ advertised by a different recruiter is not a suppressible duplicate: proceed as its own approved application and reuse the group's tailored artefacts where suitable. Only an exact repeat through the same recruiter should trigger the duplicate decision.

## Boundaries

- The harness doesn't click submit for the user here. It prepares everything; the user finalises.
- If the user provides a confirmation reference, store it in the opportunity's archive so follow-ups can quote it.
- Never let the timebox bypass an approval, validation, screening-answer, or duplicate gate.
