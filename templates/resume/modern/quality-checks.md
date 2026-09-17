# modern — per-template quality-check overrides

Universal checks live at `.claude/skills/resume-render/references/quality-checks.md`. The list below either overrides a universal check or adds a template-specific one.

## Skipped universal checks (template-justified)

None. The active `modern` template renders presentation PDF via HTML/CSS + Playwright and ATS docx via the shared `_ats-docx.ts` path, so browser-chrome and ATS-lint checks both apply.

## Template-specific additions

### header_rule_visible
- **what**: a thin black horizontal rule appears under the name/headline block on page 1.
- **how**: read page 1 PNG; verify a single restrained horizontal rule under the header, above the contact line.
- **auto_fix**: none — template-level CSS (`header` border).
- **severity**: warn

### date_alignment_right
- **what**: experience-header dates render right-aligned with tabular numerals on the same line as title/company.
- **how**: read each page PNG.
- **auto_fix**: none — template-level.
- **severity**: warn

### section_headings_muted_uppercase
- **what**: section H2s render as muted uppercase labels with a light grey divider line beneath each visible heading, distinct from body text without dominating the page.
- **how**: read page PNGs; verify section headings are small, uppercase, spaced, grey/muted, and carry a subtle light grey rule underneath.
- **auto_fix**: none — template-level.
- **severity**: warn

### experience_heading_not_orphaned
- **what**: an experience heading should not start as the final readable line of a page.
- **how**: read page PNGs at page bottoms. If a role heading appears at the bottom, confirm at least the role summary or first bullet travels with it; otherwise move the role start to the next page.
- **auto_fix**: template-level pagination CSS: keep `.xp-head` and `.xp-sum` with following content, but do not force the whole `.xp` block to stay together because that can create an unnecessary extra page.
- **severity**: warn

### earlier_continues_experience
- **what**: earlier-career mentions continue the Experience section without a separate visible "Earlier" heading.
- **how**: read later-page PNGs, generated HTML, markdown, or DOCX text; verify compact earlier-career rows follow featured Experience entries directly, with no standalone "Earlier" section label.
- **auto_fix**: render `placement: "mention"` rows inside the Experience section; keep semantic mention placement in `ResumeContent` for composition and line-budget checks.
- **severity**: warn

### unheaded_impact_bullets
- **what**: selected-impact bullets flow directly after the unheaded summary, without a visible "Selected Impact" heading.
- **how**: read page 1 PNG or generated HTML; verify summary prose is followed by bullets and the first visible section heading is "Skills".
- **auto_fix**: set `omitImpactHeading: true` and order summary → impact → skills in the modern template design.
- **severity**: warn

### impact_bullets_two_lines
- **what**: each selected-impact bullet renders in no more than two lines in the presentation PDF.
- **how**: read page 1 PNG; count wrapped lines for each bullet in the unheaded impact list.
- **auto_fix**: shorten/re-author highlights; prioritise one compact claim per bullet.
- **severity**: warn

### skills_before_experience
- **what**: Skills appears before Experience in the presentation PDF.
- **how**: read page 1 PNG or generated HTML; verify the first visible heading after summary/impact bullets is "Skills", followed by "Experience".
- **auto_fix**: set modern `sectionOrder` to summary → impact → skills → experience.
- **severity**: warn

### summary_heading_omitted
- **what**: the opening summary renders as an unheaded lead paragraph; no visible "Summary" or "Professional Summary" label appears in the presentation PDF.
- **how**: read page 1 PNG or generated HTML and confirm the first body section starts directly with summary prose.
- **auto_fix**: set `omitSummaryHeading: true` in the modern template design.
- **severity**: warn

### print_safe_contact_links
- **what**: contact URLs render as readable profile URLs, not short labels such as "LinkedIn" or "GitHub"; country names are written out for print.
- **how**: inspect page 1 PNG / generated HTML / markdown contact line; verify `linkedin.com/...`, `github.com/...`, and `Australia` are visible.
- **auto_fix**: shared contact helpers in `templates/resume/_docx-helpers.ts` and `templates/resume/_html-resume.ts`.
- **severity**: warn

### bundled_fonts_loaded
- **what**: rendered text uses bundled fonts: EB Garamond for the name and Inter for body text, not Helvetica or Arial fallback.
- **how**: inspect any page PNG; if text looks like Helvetica or Arial, check `templates/resume/fonts/*` and the generated HTML's embedded `@font-face`.
- **auto_fix**: none — template/font bundle issue.
- **severity**: warn
