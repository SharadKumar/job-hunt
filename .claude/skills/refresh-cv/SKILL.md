---
name: refresh-cv
description: Re-parse the user's master CV .docx into state/profile/cv-source.md. Use when the user says "I updated my CV", "re-parse my resume", "pull in the new CV", "I added a role", "refresh my profile", or after any change to the master .docx file in the user's Resume directory.
---

# /refresh-cv: re-parse the user's master CV into cv-source.md

Use when the user updates their master CV (`~/Documents/Resume/master-cv.docx` by default, or the path recorded in `state/profile/cv/meta.yaml`) and wants the harness to re-ingest.

## What to do

Resolve the repo root first (`references/harness/repo-root.md`).

1. Read the source path from `state/profile/cv/meta.yaml` (`source_file` field). Default: `~/Documents/Resume/master-cv.docx` (typically a symlink to the user's current authoring file).
2. Check if the source file's mtime is newer than `meta.yaml`'s `parsed_at`. If not newer, ask: "Source unchanged since last parse. Re-parse anyway / cancel?"
3. Backup current cv-source.md to `state/profile/cv-source.bak-<timestamp>.md` before overwriting.
4. Run `npm run markdownify:cv` (uses defaults from meta.yaml). This reads the master .docx via mammoth, runs the tidy() pass (strip backslash escapes, promote bold role headers to `### `), and writes `state/profile/cv-source.md`. meta.yaml's `parsed_at` is updated.
5. Show a diff summary: new headings added, removed, content delta (line counts, role count).
6. Ask: "Looks good / let me hand-edit cv-source.md first / restore from .bak?"
7. If approved: discard the .bak after the user confirms. Otherwise: `mv` the .bak back to cv-source.md.

## When to ask

- If the parsed cv-source.md is significantly smaller than the previous version → ask: "New CV is N% smaller. Removed roles intentionally / parser missed sections / restore?"
- If a role you remember being in the old cv-source.md isn't in the new one → ask: "Role X is missing. Removed intentionally / look in the master .docx and adjust there / restore?"

## Boundaries

- Doesn't touch the source `.docx` file. The user maintains that.
- Doesn't write to the archived atomic tree under `state/profile/cv/_archive_atomic_20260528/`.
- Re-rendering of baselines is NOT automatic: after this skill completes, suggest `/resume-review` if the changes look significant enough to warrant fresh baselines.
