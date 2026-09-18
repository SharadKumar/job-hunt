---
name: resume-critique
description: Run the independent content review of a rendered CV before anyone is offered the chance to approve it. Use when the user says "critique my CV", "review the content of this resume", "is this CV actually good", "check for duplicate bullets", "did it contradict itself", or after any render where the deterministic gates passed but nobody has read the document as a human. Also invoked by /resume-render, /resume-review and /apply's tailored path, which must not offer approval until this skill has returned a critic pass. Argument is the resume-id, plus optional `--rounds N` (default 2) and `--profile <id>`.
---

# /resume-critique: the read the gates cannot do

## What this skill does

`npm run resume:audit` decides mechanical facts: page count, line fill, ATS lint, term grounding, matched editorial bans. It is blind to the defects that actually cost an interview. The one that created this skill: two adjacent bullets in one role, one opening `the side project (<parenthetical gloss>, <qualifier>):` and the next opening `the side project:`, overlapping in substance. Every gate passed. A recruiter would read padding.

This skill spawns the **resume-critic** subagent for that judgement, applies what it proposes deterministically, re-audits, and re-runs the critic until it passes or the round cap is spent. The critic stays a subagent because context isolation is the point: it must read the rendered document cold, without the writer's reasoning in its context telling it why every choice was right.

Nothing this skill does lives only in the conversation. Every round lands in `<prefix>.critic.json`, the verdict lands in `metadata.json`, and `npm run resume:approve` refuses without a current one.

## Arguments

- `<resume-id>` (required): must match `state/profile/resumes.yaml`, or the profile's `resumes.yaml` when `--profile` is given.
- `--rounds N` (default 2): the maximum number of critic passes. Round 1 reviews, round 2 re-reviews after the edits land. More than 2 is almost always the wrong fix; a CV that cannot converge in two rounds has a composition problem, not a wording problem.
- `--profile <id>`: team profiles resolve under `state/profiles/<id>/`; the default stays `state/profile/`.

## Sequence

Resolve the repo root first (`references/harness/repo-root.md`). `<profile-dir>` is `state/profile/` or `state/profiles/<profile-id>/`. `<dir>` is `<profile-dir>/resumes/<resume-id>/`. `<prefix>` is the path stem inside `<dir>` shared by `*.composition.json`, `*.provenance.json`, `*.audit.json` and the rendered `.md`.

### 1. Confirm there is something to review

The composition and the rendered markdown must both exist in `<dir>`. If they do not, stop and say so: this skill reviews an artefact, it never renders one. Route the user to `/resume-render` or `/resume-review`.

### 2. Re-run the deterministic gates yourself

The critic reviews content, not mechanics, and it must not be handed a CV that is already failing a gate.

```
npm run resume:audit -- --resume <id> --content-json <prefix>.composition.json --out-dir <dir> --strict-line-units true [--profile <p>] [--keyword-plan <dir>/keyword-plan.json]
npm run resume:term-grounding -- --content-json <prefix>.composition.json [--keyword-plan <dir>/keyword-plan.json]
```

A `fail`-severity exit here is a hard stop: fix the mechanics first (re-invoke resume-writer with the named failing units), then come back. Do not spend a critic round on a CV the gates already rejected.

### 3. Spawn the critic (round 1)

One Agent call, `subagent_type: resume-critic`:

```
Agent(subagent_type: "resume-critic",
      description: "Content review of <resume-id>",
      prompt: "Review the rendered CV for resume <resume-id>. Artefact prefix: <prefix>. Profile: <profile-id or default>. Round: 1 of <N>. Read `npm run resume:context -- --resume <resume-id> [--profile <p>]`, then the rendered <prefix>.md cover to cover, then <prefix>.composition.json, <prefix>.provenance.json, the profile's resume-editorial-rules.md, and the cited cv-source.md line ranges for any claim you doubt. The deterministic gates have already passed, so do not re-report them. Return your compact JSON only, and persist it with `npm run resume:critic:apply -- --composition <prefix>.composition.json --findings <scratch>.json --record-only`.")
```

### 4. Act on the verdict

**`pass`**: record it (the critic already did, via `--record-only`), print the summary, and stop. The caller may now offer approval.

**`block`**: stop. Do not apply anything, do not start another round. Surface the findings to the user with `AskUserQuestion` (Codex: `request_user_input`), recommended option first:
- `Fix the source and re-render (Recommended)`: a `contradiction`, `unsupported` or `rule` finding usually traces to the corpus or the positioning, not the wording. Route to `/refresh-cv`, `/resume-strategy`, or the keyword-confirm patch flow.
- `Apply the critic's proposed edits anyway`: only when the user reads the findings and judges the proposed wording correct.
- `Approve without a review`: spells out that `npm run resume:approve -- --resume <id> --skip-critic` logs the override into `metadata.json`.
- `Cancel`.

A block verdict never converts itself into an approval offer. That is the whole point of the verdict.

**`revise`**: apply, re-audit, and go again:

```bash
npm run resume:edit -- --resume <id> [--profile <p>] --edits <scratch>.json --images
```

One command, one process: it applies every exact `proposed_edit` (skipping every finding without one), appends the round to `<prefix>.critic.json`, updates the provenance sidecar through the fit ops, re-anchors provenance against `cv-source.md`, stamps `metadata.json`, re-runs the full audit in place with `--strict-line-units true`, and appends any finding that has now recurred across two or more resumes to `<profile-dir>/resume-editorial-rules.md`. It also prints suggested `editorial-bans.yaml` rules; it never writes that file, because a machine ban gates every future render and that is the user's call. Offer any suggestion it printed to the user at step 6.

The critic's own findings JSON is accepted as-is. When YOU need an edit the critic did not phrase as a finding, write the plain form instead, with the same command and the same file argument:

```json
{ "edits": [ { "path": "experiences[2].bullets[3]", "text": "New wording.", "why": "why" } ] }
```

`"text": "delete"` removes a unit and benches it with its provenance. The critic itself still runs `--record-only` (it records, it never applies).

Read the single JSON it prints: `applied`, `skipped`, `reanchor`, `audit` and `next`. Exit 0 clean, 1 something was skipped or the audit warns with failing units, 2 audit fail or critic block. The re-audit inside it matters: a replacement of a different length moves the page fit. If the audit now fails, do not start another critic round; surface the failing units and re-invoke resume-writer.

Then spawn the critic again with `Round: 2 of <N>`, noting which findings were applied and which were skipped with their reasons. Stop at the round cap whatever the verdict, and report the last verdict honestly.

### 5. Skipped findings are not resolved findings

A finding in the `skipped` list (no exact `proposed_edit`, a unit path it cannot address, or a quote that no longer matches) is still open. Carry it into the summary and into the user's decision. Never report a round as clean because the tool had nothing to apply.

### 6. Print the review summary

Short, and no more than this:

```
Critique: <resume-id>   rounds 2/2   verdict revise
Round 1  revise  4 findings (2 fail, 2 warn)  applied 3, skipped 1
Round 2  pass    0 findings
Open:    f4  register at experiences[1].bullets[2]: reads like a job advert, no exact edit proposed
Learned: duplicate "<venture> <employer> s open agentic development framework" now on 2 resumes, appended to resume-editorial-rules.md
Suggest: 1 editorial-bans.yaml rule printed above, not written
Trail:   <prefix>.critic.json
```

Then hand control back to whoever invoked this skill. Approval is never this skill's decision.

## Boundaries

- **Never approve.** Even on a clean pass. `/resume-render` and `/resume-review` own the approval question, and the user answers it.
- **Never edit the composition by hand.** Every edit goes through `resume:edit` so the provenance sidecar, the review trail and the metadata stamp all move together. A hand edit leaves the critic hash pointing at a composition that no longer exists, and `resume:approve` will refuse.
- **Never edit canonical files.** `cv-source.md`, `profile.md`, `resumes.yaml` and `editorial-bans.yaml` are user-owned. The only file this flow appends to is `resume-editorial-rules.md`, and only for a finding that has recurred across two or more resumes.
- **Never exceed the round cap**, and never restart the count after applying edits. Two rounds is a review; five is the critic and the writer arguing.
- **Never let the critic render or audit.** It reads and judges. This skill runs the tools.

## When to invoke vs decline

Invoke when a rendered CV exists and nobody has read it as a document: after any render, before any approval, and whenever the user doubts the content rather than the layout.

Decline (route elsewhere):
- "The CV is four pages" / "this bullet wraps badly" → mechanics, `/resume-render`.
- "Change my positioning" → `/resume-strategy`.
- "I updated my CV" → `/refresh-cv`, then re-render, then come back here.
