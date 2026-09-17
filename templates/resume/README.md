# CV Templates (harness-level library)

Shared across all profiles. Each subdirectory is a named template; profile
`resumes.yaml` entries pick one via `template: <name>`.

Templates are renderers, not content stores:
- `render.ts` — a **design declaration** plus `export default defineHtmlTemplate(DESIGN)`. No render logic lives here.
- `styles.css` — **the design** (HTML templates). The signed-off target; the runtime stylesheet. No separate spec to drift from.
- `template.md` — metadata plus composition constraints for `resume-writer`.
- `quality-checks.md` — per-template visual/structural checks or overrides.
- `sample/sample-content.json` + `sample/golden*.png` — the frozen golden (committed). The render of the sample by the same code that runs at runtime — the visual sign-off + drift anchor.

## Rendering model (two flavours, two media)

Each template emits up to two artefacts from one `ResumeContent`:
- **`presentation`** — the designed, world-class PDF a human reads. The live templates (`modern`, `classic`, `minimalist`, `modern-columns`) render it from **HTML/CSS → Playwright headless-Chromium PDF**: a shared content→HTML builder (`_html-resume.ts`) + the template's `styles.css` + bundled fonts (`fonts/*.woff2`, embedded as @font-face for determinism). The design lives entirely in `styles.css`; the HTML structure is shared and single-logical-column.
- **`ats`** — a plain, single-column, parseable `.docx` for ATS/portals, produced by the ONE shared renderer (`_ats-docx.ts`), identical for every template (ATS ignores design). Carries clickable contact + in-prose links.

Shared infra: `_html-template.ts` (`defineHtmlTemplate` — the ONE render body), `_html-helpers.ts` (HTML→PDF, fonts, escape/linkify), `_html-resume.ts` (content→HTML), `_ats-docx.ts` (ATS docx), `_docx-helpers.ts` (docx primitives), `_pandoc-helpers.ts` (`assembleMarkdown` only — the `.md` artefact). Regenerate a golden with `npm run resume:design:golden -- --template <name>`.

Neither LibreOffice, pandoc nor a system Chrome is a dependency. The docx→PDF and pandoc/chrome render paths were deleted on 2026-09-10; presentation PDFs come from Playwright's bundled Chromium and the ATS docx is built in-process by the `docx` library.

## The template contract

`render.ts` exports a `ResumeTemplate` built by `defineHtmlTemplate(design)`. The design object is the whole template:

| Field | Meaning |
|---|---|
| `name` | Directory name; becomes `meta.template`. |
| `design` | Visual-identity slug; becomes `meta.design`. |
| `cssPath` | Absolute path to this template's `styles.css` — **the design**. |
| `fonts` | Bundled WOFF2 faces from `fonts/`, embedded as @font-face data URIs so renders never depend on host-installed fonts. |
| `labels` | Section headings (`summary`, `impact`, `experience`, `skills`, `earlier`, optional `credentials`). |
| `sectionOrder` | Section sequence; defaults to summary → impact → experience → skills → earlier → credentials. |
| `omitSummaryHeading` / `omitImpactHeading` / `omitEarlierHeading` | Drop a visible `<h2>` where the design reads better without it. |
| `layout` | `"single"` (default) or `"skills-columns"` — see below. |

`defineHtmlTemplate` then supplies the render body for both flavours, so a fix to the render path (shared browser session, orphan repair, artefact naming) lands in every template at once. A template that hand-rolls its own `render` function is legal but loses that and cannot be used as a `--from` source for the scaffold.

### `layout` and why page layouts are constrained

- **`"single"` (default)** — one semantic column. Every rendered line participates in the page-fit arithmetic.
- **`"skills-columns"`** — only the skills block renders in CSS multi-columns. The columned container carries `data-flow="secondary"`, which `tools/resume/lib/measure-document.ts` records on each line unit and `lib/fit-core.ts` uses to **exclude those lines from the fit maths**. Column-balanced lines are not one-for-one addable or removable, so counting them would corrupt "add N lines / remove N lines" advice. `templates/resume/modern-columns/` is the worked example.

**Sidebar and true two-column PAGE layouts are unsupported for now.** Three things break at once:
1. Chromium fragments multi-column and flex/grid content across printed pages unpredictably, so the PDF page count stops being a stable function of the content.
2. `repairPageBreakOrphans` is a single-flow repair: it decides that a heading is stranded by comparing one element's geometry to one page boundary. With two independent flows there is no single "next element" to reason about.
3. The fit arithmetic converts a fill percentage into rendered lines through one median line height and one measured lines-per-page. Two flows with different measures make that conversion meaningless.

Two further invariants hold regardless of layout:
- **DOM order stays semantic.** PDF text extraction (ATS parsers, and our own `pdftotext` gates) reads the DOM order, so a layout may move pixels but never reorder content. `skills-columns` wraps the existing blocks in place; it does not move the skills section.
- **The ATS docx is always single column**, for every template, with no design at all. `_ats-docx.ts` ignores `layout` entirely.

## Adding a template

Scaffold from an existing one — don't hand-copy, the rubric's `template:` key and the golden are easy to forget:

```bash
npm run resume:template:new -- --name <new> --from modern \
  [--layout single|skills-columns] \
  [--font "Family Name=File.woff2"]     # repeatable; file must already be in fonts/
```

It copies and rewrites `render.ts` (name, design id, fonts, layout), `styles.css`, `rubric.yaml` (`template:`), `quality-checks.md`, `template.md` (version 1, today's date, a scaffold note) and `sample/sample-content.json`, then generates the golden and runs the template smoke check. It refuses if the name already exists or starts with `_` (reserved for shared infra files).

Then:

1. Edit `styles.css` — that IS the design; nothing else defines the look.
2. Rewrite `template.md` identity, persona fit and composition constraints (they arrive inherited from the source template and are not yet yours).
3. Tune `rubric.yaml` line-unit budgets to the new typography — character targets follow measure width, so they rarely survive a font or margin change.
4. Re-run `npm run resume:design:golden -- --template <name>` and commit the PNGs; the git PNG diff is the visual sign-off surface.
5. Confirm `npm run resume:templates:check` is no worse than before.

## Improving an existing template

Tweaking a template helps every profile that uses it. The compounding pattern:

1. Edit `render.ts` and/or template metadata.
2. Bump `version` in `template.md` and update `last_updated` + `notes`.
3. Commit. All baselines using this template flip to "stale" on next writer-driven render; profiles re-review.

The `/cv-template` skill walks you through these operations.

## Removing or renaming

- Don't rename or delete a template while profiles reference it — `resumes.yaml` entries break.
- Use `/cv-template deprecate <name>` first (marks in metadata so profiles get a warning) before removal.
