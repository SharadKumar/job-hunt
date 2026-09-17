---
name: review-drafts
description: Walk through queued draft applications interactively at the laptop — approve, edit, reject, or hold each one. Use when the user asks to "review drafts", "go through the tray", "approve applications", "look at what's queued", "qualify roles", or wants a synchronous batch-review session instead of using the Sheet on phone.
---

# /review-drafts — qualify drafts interactively

When the user is at the laptop and wants to qualify a batch of drafts without going to the Sheet on phone. Walks each `awaiting_approval` opportunity one at a time.

## What to do

Resolve the repo root first: run `bash .claude/hooks/repo-root.sh` and treat its output as the base for every path below; never assume cwd.

1. **Drain pending keyword confirmations first** — `npm run resume:keyword-confirm -- pending --group-by term`. These are `kind: keyword` rows queued as `pending` by unattended `/daily` runs (and by earlier "Unsure / keep pending" answers), grouped by term across opportunities, busiest first. If the count is 0, move on.
   - Ask in batches of **at most 4** per `AskUserQuestion`, with exactly these options: `Confirm and update source (Recommended)` / `Not applicable` / `Bring in as familiarity` / `Unsure / keep pending`. Question text = the row's `question` plus its `evidence_hint`. One question per term, even when several opportunities queued it.
   - Record each answer with `npm run resume:keyword-confirm -- record --plan <plan-path> --term "<term>" --status confirmed|not_applicable|pending --origin attended` (the row names its `opportunity_id`; that archive holds the plan, or regenerate one with `npm run resume:keywords -- --resume <id> --proactive`).
   - On `Confirm and update source`, show the proposed bullet and ask `Apply this wording (Recommended)` / `Edit wording` / `Skip`, then run `npm run resume:keyword-confirm -- apply-patch --term "<term>" --resume <id> --role-heading "<heading substring>" --bullet "<final text>"` (add `--skills` for a Skills-section fact). It prints the diff it applied and clears `source_update_required`. Never hand-edit the ledger or `cv-source.md`.
   - Note which resumes had their source patched: their baselines are now stale, so mention `/resume-review` at the end of the session.
2. `npm run pipeline -- get --status awaiting_approval` to load the queue.
3. If empty, say so and stop.
4. For each opportunity (highest score first):
   - Show a tight summary: opportunity title, company, channel, score (with top 3 reasons), red flags, chosen resume, page count, cover-letter preview (first 2 sentences), URL.
   - Open the rendered PDF/docx path in the conversation (or print the path).
   - Ask via `AskUserQuestion`: "Approve / Edit / Reject / Hold?"
   - If **Approve**: set status `awaiting_approval → approved` and prepare the complete validated package in `manual_action_needed`. This does not authorize submission. The user must later confirm that exact package in an attended `/submit-approved` or `/apply` flow.
   - If **Edit**: ask for the change in free text. Re-run the **application-assembly orchestration** with the user's brief — the same pattern as `/apply`: spawn `cover-letter-writer` (and `resume-writer` if the change touches the CV) as peer subagents, route through slop-killer + voice-check + lint. The new draft bounces back to `awaiting_approval`.
   - If **Reject**: set status `→ rejected`. If the reason looks like a recurring pattern (same company/recruiter rejected before), ask: "Add to ignore list / one-off reject?"
   - If **Hold**: no-op, leave a note.
5. After the queue, `state-syncer` mirrors to the Sheet.

## Boundaries

- Approve here is the same kind of preparation approval as ticking `approve` in the Sheet. It does not authorize a later unattended submit. External submission requires the user to be present and freshly confirm the exact package in `/apply <opportunity-id>` or attended `/submit-approved`.
- Never auto-edit drafts. The user types the edit; the drafter rewrites.

## When to ask

- Keyword confirmations in step 1: batched, at most 4 at a time, never open-ended.
- If > 10 rows in the tray, ask first: "Walk all (recommended) / top 5 by score / let me filter by channel?"
- If a draft trips slop-killer (left in `drafted` not `awaiting_approval`), surface it separately and ask: "Force-approve with the slop warning / send back for another regen / hand-edit in the file?"
