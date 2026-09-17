# minimalist — per-template quality-check overrides

Universal checks live at `.claude/skills/resume-render/references/quality-checks.md`. The list below either overrides a universal check or adds a template-specific one.

## Skipped universal checks (template-justified)

None. The active `minimalist` template renders presentation PDF via HTML/CSS + Playwright and ATS docx via the shared `_ats-docx.ts` path, so browser-chrome and ATS-lint checks both apply.

## Template-specific additions

### no_visible_rules
- **what**: zero horizontal rules, zero accent lines, zero coloured borders. The restraint is the design.
- **how**: read every page PNG; verify no underline rule under any section heading, no accent line below contact.
- **auto_fix**: none — template-level.
- **severity**: fail (if a rule appears, the template was modified incorrectly).

### name_understated
- **what**: name renders in regular weight, NOT bold. Tests the "understatement IS the statement" rule.
- **how**: read page 1 PNG; name should not look heavier than section headings.
- **auto_fix**: none — template-level.
- **severity**: warn

### experience_before_skills
- **what**: in the rendered presentation document, the "Experience" section appears before "Skills".
- **how**: read page PNGs or inspect `golden.html`; verify Experience comes before Skills in the presentation flow.
- **auto_fix**: none — template-level (`buildResumeHtml` section order).
- **severity**: fail (if Skills comes before Experience, the renderer broke).

### hanging_indent_only
- **what**: bullets render as restrained en-dash list items, not heavy round bullet glyphs.
- **how**: read page PNGs; list markers should be light en dashes with hanging alignment.
- **auto_fix**: none — template-level CSS.
- **severity**: warn

### strict_two_pages
- **what**: rendered PDF is exactly 2 pages. Three pages on this template fails the design contract; recompose with fewer experiences/bullets, OR switch to `classic`.
- **how**: pdfinfo page count.
- **auto_fix**: TRIM ladder. If still over after exhausting trim, surface to user: "minimalist demands 2pp strict; this corpus needs classic instead."
- **severity**: fail
