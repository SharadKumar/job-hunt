---
name: my-contracting-application-progress
description: Reconcile My Contracting pipeline progress, prepared application packages, evidence, blockers, and owner decisions without taking external action.
---

# Application progress

Use this skill for a bounded reconciliation of application progress. Local
files under `state/` are authoritative; Google Sheets is a mirror except for
the Tray `Action` and `Edits` columns described in `AGENTS.md`.

## Authority boundary

Unattended work ends at a complete, validated package in the prepared manual
queue. A Sheet approval authorizes preparation and queue reconciliation only.
Every external submission, employer or recruiter contact, message, portal
confirmation, or irreversible form action requires the current profile owner to
be present and approve that exact application at the action point.

Never invoke `submission-runner`, `submit-approved`, a submit adapter, a send
action, or an irreversible browser action. Evidence from an attended submission
may be reconciled later, but this skill must never perform or retry it.

## Work

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

1. Follow the session-start protocol in `AGENTS.md`, then read
   `state/profile/profile.md`, `state/pipeline/opportunities.json`, the prepared
   queue, audit log, and latest journal entry.
2. Pull the two user-writable Tray fields through the repository's supported
   sync path. Do not treat any other Sheet value as authoritative.
3. Reconcile pipeline transitions, prepared packages, blockers, and recoverable
   work evidence. A terminal tool or session result is evidence to inspect, not
   completion without the corresponding canonical state change.
4. Correct or supersede inaccurate checkpoint evidence in its existing owner,
   deduplicate real blockers, and surface only decisions that genuinely require
   the current profile owner.
5. After any state mutation, run state validation and Sheet synchronization,
   then add the required concise journal entry.

Finish with meaningful changes, failures or stale evidence, decisions needed,
and the next owner action. When nothing material changed, return `[SILENT]` if
the caller requested quiet operation. Do not edit scheduler, runtime, or
delivery configuration from this skill.
