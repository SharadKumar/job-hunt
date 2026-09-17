# classic — per-template quality-check overrides

Universal checks live at `.claude/skills/resume-render/references/quality-checks.md`. The list below either overrides a universal check (`skip` or different severity) or adds a template-specific one.

## Skipped universal checks (template-justified)

None. The active `classic` template renders presentation PDF via HTML/CSS + Playwright and ATS docx via the shared `_ats-docx.ts` path, so browser-chrome and ATS-lint checks both apply.

## Template-specific additions

### date_alignment_right
- **what**: experience-header dates render right-aligned on the same line as title/company, in italic.
- **how**: read each page PNG; verify dates appear at the right margin per featured experience.
- **auto_fix**: none — template-level (tab-stop in experienceTitle()).
- **severity**: warn

### section_underline_consistent
- **what**: each visible section H2 has the same thin grey underline rule.
- **how**: read each page PNG; verify the rule appears under every H2.
- **auto_fix**: none — template-level.
- **severity**: warn

### skills_before_experience
- **what**: Core Skills appears before Professional Experience in the presentation PDF.
- **how**: read page 1 PNG or generated HTML; verify the first visible heading after summary/impact bullets is "Core Skills", followed by "Professional Experience".
- **auto_fix**: set classic `sectionOrder` to summary → impact → skills → experience → credentials; compact mention rows continue inside Experience.
- **severity**: warn

### name_h1_distinct
- **what**: name (H1) renders clearly larger than section H2s.
- **how**: read page 1 PNG; visual size comparison.
- **auto_fix**: none — template-level.
- **severity**: warn

### serif_font_loaded
- **what**: rendered text uses the bundled EB Garamond webfont, not Times New Roman or Arial.
- **how**: inspect any page PNG; if it looks like a system fallback, check `templates/resume/fonts/EBGaramond-*.woff2` and the generated HTML's embedded `@font-face`.
- **auto_fix**: none — template/font bundle issue.
- **severity**: warn
