---
name: my-contracting-discovery-import
description: Discover, enrich, deduplicate, score, and import contracting opportunities into the canonical local pipeline without submitting or contacting anyone.
---

# Discovery and import

Use this skill for a bounded My Contracting discovery or import pass. Local
files under `state/` are authoritative; Google Sheets is a mirror except for
the Tray `Action` and `Edits` columns described in `AGENTS.md`.

## Authority boundary

The outcome is evidence in the canonical pipeline and, where warranted, a
complete validated package in the prepared manual queue. A Sheet approval can
authorize preparation and queue reconciliation, but not an external action.

Never submit an application; contact an employer or recruiter; send a message;
confirm a portal action; invoke `submission-runner`, `submit-approved`, or a
submit adapter; or perform an irreversible browser action. Those actions need
the current profile owner to be present and approve that exact application at
the action point.

## Work

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

1. Follow the session-start protocol in `AGENTS.md`, then read
   `state/profile/profile.md`, enabled channel configuration,
   `state/pipeline/opportunities.json`, and the latest journal entry.
2. Inventory current pipeline records before querying an enabled source. Use
   the repository's dedicated `npm` scripts and channel adapters, preserving
   reported, case-supplied, verified, and inferred provenance distinctly.
3. Canonicalize and deduplicate findings before scoring or importing them.
   Enrichment may add evidence but must not silently advance workflow state.
4. Prepare drafts or application materials only when the repository policy and
   current queue authorize that internal step. Preserve the manual-action gate.
5. After any state mutation, run state validation and Sheet synchronization
   through the repository's supported path, then add the required concise
   journal entry.

Finish with the records added or changed, source evidence, validation and sync
results, unresolved blockers, and the next owner action. Do not edit scheduler,
runtime, or delivery configuration from this skill.
