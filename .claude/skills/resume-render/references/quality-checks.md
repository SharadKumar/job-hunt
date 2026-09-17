# CV quality checks (universal)

The checks resume-writer runs against EVERY rendered CV, regardless of template. These are template-agnostic — they describe what makes any CV proper at a structural and visual level.

resume-writer reads this file first, then optionally overlays per-template overrides from `templates/resume/<name>/quality-checks.md` (rare — only used when a template genuinely contradicts or extends a universal check).

Each check declares:
- **id**: short, machine-readable identifier (becomes a key in resume-writer's `checks` report)
- **what**: human description
- **how**: how resume-writer checks (which tool + what to look for)
- **auto_fix**: if resume-writer can fix it without surfacing, the action to take
- **severity**: `pass | warn | fail` — `fail` means human review needed; `warn` is logged but doesn't block

resume-writer reads page PNGs (produced by `npm run resume:to-images -- --pdf <path>`) with the Read tool to perform visual checks. Multimodal — the subagent literally looks at the images.

---

## Structural (text-based, deterministic)

### page_count
- **what**: total pages ≤ target's max (default 3, configurable via `--max-pages`)
- **how**: `npm run resume:page-fill -- --content-json <composition.json> --resume <id>` — returns page count, per-page fill %, the gap expressed in rendered lines, and ranked candidate edits addressed by composition path. Prefer this over a bare `pdfinfo <pdf>`: it measures page count and fill in one pass and says what to change to close the gap.
- **auto_fix**: resume-writer applies the ladder rung that closes the reported line gap (drop a featured experience to mention; trim bullets per featured; shave a ragged tail to reclaim a line); re-render; re-measure. Up to 6 attempts.
- **severity**: fail if can't converge after 6 attempts; pass otherwise

### required_sections
- **what**: every CV must contain `## Professional Summary`, `## Skills`, `## Professional Experience`
- **how**: grep rendered `cv.md`
- **auto_fix**: none — missing section indicates content layer bug
- **severity**: fail

### bullet_density
- **what**: each experience block has 2-8 bullets after variant-tag filtering. < 2 = too sparse (tag has no matching bullets); > 8 = too dense (wall of text)
- **how**: parse `cv.md` per experience section
- **auto_fix**: `> 8` reduce `--max-bullets`; `< 2` surface (variant tag misaligned)
- **severity**: warn for high density; fail for zero bullets per experience

### ats_lint
- **what**: docx is free of MECHANICAL ATS hazards (no embedded images/icons, no objects/SVG, no tables, page count within budget, JD keyword overlap). Section/heading soundness is NOT checked here — it's a semantic judgement made by the resume-writer's visual review (templates legitimately letter-space headings or show an unlabeled summary, so literal heading matching is unreliable).
- **how**: `npm run resume:lint:ats -- --file <docx>`
- **auto_fix**: `warn` accepted; `fail` surface — template producing ATS-hostile output
- **severity**: fail blocks; warn logs

### research_rubric
- **what**: rendered resume satisfies the template's research-backed rubric: safe headings, section order, page budget, summary length, grouped skills, experience/bullet density, weak bullet starts, rendered line-fill, and quantified-evidence threshold
- **how**: `npm run resume:evaluate -- --template <template> --content-json <composed-json> --docx <docx> --pdf <pdf> --html <html> --md <md>`
- **auto_fix**: recompose for content warnings (density, under-filled pages, line-fill, overlong bullets, weak starts); surface heading, page hard-limit, or rubric-reference failures as template/harness issues. Do not change template CSS, font size, line-height, margins, section spacing, bullet spacing, or page breaks to hide sparse content; page-fill is solved by selecting more source-backed content or by reporting that the corpus is too thin for the requested page budget.
- **severity**: fail blocks; warn logs

### no_markdown_artefact_leak
- **what**: no escape leakage from the parser (`\(`, `\.`, `&#x2F;`, `&amp;`)
- **how**: grep `cv.md`
- **auto_fix**: none — parser bug; surface for upstream fix
- **severity**: fail

### source_provenance
- **what**: authored resume claims are traceable back to canonical source (`state/profile/cv-source.md` plus profile frontmatter). Summary, highlights, skills, featured-experience summaries, bullets, and mentioned one-liners must have source line references in `ResumeContent.source_provenance`; `unsupported_claims` must be empty.
- **how**: run `npm run resume:provenance -- --content-json <prefix>.composition.json`, then spot-check line references against `state/profile/cv-source.md`. The script validates that provenance exists, hashes match when supplied, cited line ranges exist, and `unsupported_claims` is empty. The writer still performs the semantic check: for re-authored prose, verify the underlying fact, number, system name, company, date, and scope are supported by the cited source lines; exact wording does not need to match.
- **auto_fix**: resume-writer must either cite the correct source lines, re-author the claim so it is source-supported, or drop the unsupported claim.
- **severity**: fail

### profile_editorial_rules
- **what**: all rendered candidate-facing content honours the durable profile-specific presentation, confidentiality, and terminology rules in `state/profile/resume-editorial-rules.md` plus the selected resume's `editorial-rules.md`.
- **how**: read both rule files, inspect the final composition and rendered markdown, and check every explicit prohibition or required framing. Context-sensitive rules must be checked as combinations rather than treating a generally valid word as globally banned.
- **auto_fix**: re-author the violating unit in the composition JSON, preserve source provenance, render once, and rerun affected deterministic and visual checks.
- **severity**: fail

### term_grounding
- **what**: no term the CV asserts is borrowed from the job description but absent from the candidate's real corpus. `source_provenance` only proves a claim *cites* a valid line; it does NOT prove the cited line *supports* the claim — so a tailored bullet can lift a JD feature-word ("quote generation", "underwriting threshold", "cover expiry"), attach a plausible-but-irrelevant citation, and pass provenance. This check closes that hole. It is the durable fix for the 2026-06-18 AGI incident where an entire skills block + highlights mirrored JD insurance terms (Death/TPD/IP, underwriting, quote engine, accepted/declined) that appear nowhere in cv-source.md.
- **how**: run `npm run resume:term-grounding -- --content-json <prefix>.composition.json --jd <jd-path> --profile <id>`. It greps every distinctive term in the rendered CV against `cv-source.md` + `profile.md`. `jd_injected` flags (term ∈ JD ∧ term ∉ corpus) are the high-precision fabrication signal; `ungrounded` flags are a softer worklist. Baseline (non-tailored) renders run it without `--jd` for the ungrounded sweep only.
- **auto_fix**: resolve EVERY `jd_injected` flag by one of three moves, per the 3-tier honesty policy: (1) **corpus-backed** — the source really supports it under a synonym; add the citation; (2) **preppable domain knowledge** — reframe as honest familiarity ("working knowledge of …", never "delivered/built …") AND add the term to `composition.interview_prep_terms` so the caller can log it for the candidate to study before interview; (3) **unfakeable** — remove it. Never leave a JD term rendered as delivered work the corpus doesn't support.
- **severity**: fail when any `jd_injected` term renders as an experiential/delivered-work claim; warn for ungrounded or for terms legitimately reframed to familiarity.

### market_alignment
- **what**: market-guided language from `market_lens` is evidence-gated. Applied terms must be explicit or defensibly implicit in the source evidence; `confirmation_needed` and `missing_signals` must not appear as rendered claims.
- **how**: inspect `<prefix>.composition.json` for `market_alignment`, then compare `applied_terms` and `implicit_terms_used` against `source_provenance` and rendered markdown. Confirm any `confirmation_needed`, `open_questions`, `source_update_required`, `suppressed_confirmations`, or `missing_signals` are reported as gaps only.
- **auto_fix**: remove unsupported market terms, downgrade them to `confirmation_needed`, respect prior declined/not-applicable confirmations, or update canonical source before rendering again.
- **severity**: fail when unsupported terms render; warn when useful gaps are correctly reported.

### summary_candidate_narrative
- **what**: the summary introduces the person, not a single project. It should lead with candidate identity, seniority, role archetype, operating range, and market fit; projects appear as supporting proof, not the opening subject.
- **how**: inspect the composed summary and `npm run resume:evaluate`. Warn if the first sentence starts with an execution verb (`Built`, `Delivered`, `Founded`, etc.) or lacks a clear candidate identity such as architect, engineer, operator, lead, consultant, manager, director, CTO, or specialist.
- **auto_fix**: re-author the summary as 2-3 connected sentences: person/role narrative → accomplishment pattern across multiple anchors → current capability/outlook.
- **severity**: warn

### evidence_weighting_alignment
- **what**: when `state/profile/resumes.yaml` declares `evidence_strategy`, the rendered CV gives visible weight accordingly: magnified evidence leads summary/highlights/featured blocks, supporting evidence stays secondary, and de-emphasised evidence does not dominate page 1.
- **how**: compare the composition report, rendered markdown, and page 1 PNG against `evidence_strategy.magnify`, `support`, and `de_emphasize`.
- **auto_fix**: recompose: reorder highlights, change featured/mention placement, reduce or restore bullets, or revise summary emphasis.
- **severity**: warn

### priority_weighted_density
- **what**: content density communicates priority. Current/recent/target-critical roles should carry at least as much visual evidence as older/lower-priority roles. Filling a final page by making older roles longer while recent roles stay sparse is a failure of prioritisation.
- **how**: inspect rendered markdown and page PNGs. Compare bullet counts, summary length, and one-line/two-line balance across featured roles and compact Experience mentions. Tier 1 roles should have the richest evidence; Tier 2 roles should be moderate; mention rows should stay as consistent one-line/two-line rows unless they add distinct target-fit proof.
- **auto_fix**: rebalance from the top down: expand source-backed current/recent anchor roles first, then supporting roles, then older breadth. If the resume is over page count, shorten earlier-role hooks and featured summaries before dropping earlier-role rows. Demote or shorten older roles that visually outweigh the target-critical roles. Do not use older-role padding to satisfy page-fill.
- **severity**: warn

### impact_outcome_not_project_list
- **what**: impact/highlight bullets summarise outcomes and capability patterns, not project labels or duplicate experience details.
- **how**: inspect impact bullets. Warn if most bullets start with company/product names or read like mini project summaries rather than broad outcomes, commercial/enterprise impact, capability, scale, or operating model.
- **auto_fix**: re-author into 3-5 concise outcome/capability bullets; leave project mechanics under Experience.
- **severity**: warn

### bullet_line_fill
- **what**: rendered bullets should use line space deliberately. A one-line bullet should substantially fill the line; a wrapped bullet should not leave a tiny final-line fragment.
- **how**: run `npm run resume:evaluate` with `--html <rendered-html>` so the evaluator measures rendered line boxes at the template's print content-box width, accounting for `@page` margins. For wrapped bullets, the minimum applies only to the final rendered line, not the combined width of all lines. A single-line unit must fill 90-100% of its measured width (the rubrics fail below 90%): a short single line wastes the line and reads thin, so the width is spent on a concrete fact, number, tool or market term. For a wrapped unit the floor applies to the final rendered line only and is 75%, with 90%+ the target.
- **auto_fix**: rewrite short wrapped bullets either down to a strong single line or up to a balanced two-line bullet with a substantive final line aiming at 90%+. Do not compress evidence-rich bullets into thin one-liners merely to satisfy line fill; preserve employer-valued content, then rebalance wording or use source-backed non-bullet sections for page fill. Never pad a bullet with low-value clauses just to satisfy line fill; page count, source fidelity, and evidence quality outrank this heuristic.
- **severity**: fail where configured by template rubric.

### content_unit_line_fill
- **what**: every authored composition unit must be line-budget aware, not just bullets. This includes summary paragraphs, impact bullets, skill group ledes, skill sub-bullets, additional skills summary, featured experience summaries, experience bullets, compact Experience mention one-liners, and credentials. `earlier_one_liner` units sit below their own role/company/date heading row, so budget them as full-width summary prose (one line, two at most), not as text after a bold prefix; `skill_summary` units continue inline after the skill-group heading as a normal-style one-line capability lede, and `skill_item` units should normally be one rendered line, 2-5 items per group.
- **how**: run `npm run resume:evaluate` with `--html <rendered-html> --strict-line-units true`; templates annotate rendered units with `data-resume-line-unit`, and the evaluator checks each active template's `rubric.yaml → line_units` thresholds. Use `--show-line-units true` when diagnosing exact fragments.
- **auto_fix**: re-author the specific unit to match the template's `desired_chars`: shorten to a well-filled single line, or expand with source-backed substance to the next balanced line band. Do not use filler, CSS spacing, or punctuation tricks. For prefixed units, change the generated hook length while preserving the fixed role/company/date or skill label.
- **severity**: fail when the active template declares the unit kind in `line_units`

### em_dash_density
- **what**: em dashes should be occasional punctuation, not the default separator for resume prose.
- **how**: run `npm run slop:check -- --file <rendered-md>`. The slop checker flags drafts above one em dash per 120 words and fails severe overuse. Inspect summaries, compact experience separators, and generated one-liners because template punctuation can create slop even when authored bullets are clean.
- **auto_fix**: prefer a colon, semicolon, comma, or a new sentence. If a renderer inserts em dashes mechanically, fix the renderer rather than editing every generated resume.
- **severity**: warn/fail according to slop-check verdict.

### skills_prioritised_not_keyword_dump
- **what**: Skills is a prioritised target-fit map, not a dense keyword inventory. It should surface only skills relevant to this resume and avoid long comma-heavy technology lists. The single block with `role: "screener"` in the composition is exempt: it is the deliberate term surface for ATS/AI screeners, and its items must each be corpus-cited.
- **how**: inspect Skills in markdown/PDF, ignoring the one `role: "screener"` block. Warn if the remaining blocks include irrelevant technologies for the target, more than 4 blocks, more than 5 items per block in compact templates, or items that read as raw tool dumps without context. Warn if more than one block is marked `role: "screener"`.
- **auto_fix**: trim to 2-4 blocks and keep only high-signal capabilities backed by source evidence and target strategy.
- **severity**: warn

### jd_keyword_coverage
- **what**: the CV surfaces the JD's (or, for baselines, the resume type's market lens + keyword clouds) vocabulary wherever the corpus honestly supports it, in the JD's exact spelling.
- **how**: `npm run resume:keywords -- --resume <id> (--jd <path> [--opportunity <id>] | --proactive) --composition <composition.json>`. Read `coverage`: warn when `surfaced_pct` < 85 of renderable must-have terms, or `renderable_pct` < 60 of must-have terms (report the `questions` so the calling skill can ask the user). `skip` when no keyword plan applies.
- **auto_fix**: surface each `must_have_unsurfaced` term once in the screener block or a cited bullet, using `jd_form` (both forms when `render_both_forms`). Never add a term whose status is needs_confirmation, pending, foreign, or declined.
- **severity**: warn

### credentials_relevance
- **what**: the Education / credentials section carries only entries a reader of a long-career profile would weigh: the degree, recent and positioning-relevant certifications, prominent recognition. Old, minor training items (a decades-old process-methodology course, exam-level certificates for superseded product versions, generic training programmes) are dropped unless the positioning is specifically about that technology.
- **how**: read `credentials` in the composition against the positioning and the profile's `resume-editorial-rules.md`. Warn on any entry that is both older than roughly ten years and neither a degree, a prominent award, nor relevant to the positioning's clouds.
- **auto_fix**: remove the entry (it stays in the corpus and can return on a positioning where it matters); spend the recovered line on a short single-line unit that is under its fill floor or on experience evidence.
- **severity**: warn

### screener_surface_present
- **what**: the CV carries an explicit screener surface: exactly one skills block with `role: "screener"` holding at least 3 plan terms in exact JD form, and, when the plan reports `title.alignment: supported`, a headline that names the title family.
- **how**: `resume:keywords --composition` reports `screener_surface.screener_block_present` and `screener_surface.headline_aligned`. Warn when either is false. `skip` when no keyword plan applies.
- **auto_fix**: add or adjust the screener block from grounded / alias_grounded terms with citations; set `headline` to the supported title family. Never invent seniority.
- **severity**: warn

### additional_skills_context
- **what**: lower-priority but useful skills are summarised in one short paragraph rather than mixed into prioritised skill blocks.
- **how**: inspect Skills. The main blocks should stay sharply target-relevant; any extra breadth should appear as a concise paragraph, not another long category or tool dump.
- **auto_fix**: move adjacent/non-priority skills into `additional_skills_summary`, or drop them if they do not help the target.
- **severity**: warn

---

## Visual (multimodal — resume-writer reads page PNGs)

### layout_balance
- **what**: each page looks balanced — not "all text top, vast white below" or vice versa
- **how**: read each page PNG; judge: where does the text density sit? Top-heavy / bottom-heavy / centred?
- **auto_fix**: top-heavy may indicate next page is mostly empty → consider absorbing; bottom-heavy may indicate orphan content
- **severity**: warn

### whitespace_density
- **what**: the final page must be at least 75% filled unless the source corpus is genuinely too thin after the full composition fill-up ladder. A final page under 75% fill has under-used the page budget. Cramped > 90% (wall of text) is also a fail in the other direction.
- **how**: read each page PNG and run `npm run resume:evaluate`; use the evaluator's `last_page_fill_pct` as the objective gate for the final page.
- **auto_fix**: final page <75% → use source-backed composition changes in priority order: expand current/recent target-critical roles first, restore bullets and summaries across featured roles, then restore concise older role rows only when they add distinct target-fit evidence. Re-render and re-inspect. Cramped >90% → first compress compact mention hooks and featured summaries consistently, then reduce bullets per featured if needed. Never drop an older role row until the one-line/two-line mention option has been tried, and never fix under-fill by increasing CSS spacing, margins, font size, line-height, or page-break padding.
- **severity**: fail unless the report includes `source_limited_page_fill_exception` with the exhausted fill ladder and remaining source gaps.

### no_widow_or_orphan_lines
- **what**: no single-line orphan at top of page (widow), no section heading alone at bottom of page with content starting next page (orphan), and no experience heading/date row as the final line of a page with its summary/bullets starting on the next page. If a section heading would be the last line on a page, the renderer must add a break before that section so the heading becomes the first line on the next page. If an experience heading would be the last line on a page, the renderer must keep it with the following experience content on the next page.
- **how**: run `npm run resume:evaluate` with `--html <rendered-html>` and read page-transition PNGs. The evaluator fails `section_heading_orphan` when a rendered `section > h2` lands on page N while its first content starts on page N+1, and fails `experience_start_orphan` when a rendered `.xp-head` lands on page N while the next experience content starts on page N+1.
- **auto_fix**: template/render-level first: mark the section with a break-before page rule, or use experience-heading `break-after: avoid-page` / experience-start repair so the heading travels with its first content. Only recompose content if the render-level repair creates unacceptable page count or last-page fill tradeoffs.
- **severity**: warn

### no_overflow
- **what**: no text bleeding past page margins; no bullets running off the right edge; no horizontal scroll
- **how**: read each page PNG; verify all text sits inside visible margins
- **auto_fix**: none — overflow indicates a long bullet, table, or unhandled long URL; surface
- **severity**: fail

### no_browser_print_chrome
- **what**: no browser-print artefacts on any page — top strip showing the document title repeated, a date stamp, page numbers in `N/M` format the user didn't ask for, or a `file:///…` URL strip at the bottom. These are signs the PDF was printed via a browser engine (Chrome headless, wkhtmltopdf) that left its default print chrome on. None of this belongs on a CV.
- **how**: read each page PNG; scan the top 5% and bottom 5% of the page. Flag any of: small grey text repeating the H1 (name); a date in `dd/mm/yyyy` or `mm/dd/yyyy` format pinned at a corner; a `file://...` or `http://...` strip; a "Page N of M" footer the template didn't intend; the literal text "about:blank"
- **auto_fix**: none — this is a renderer bug. Surface with the specific artefact seen, the page(s) it appears on, and the suspected source (Playwright `page.pdf()` header/footer defaults, a stray `@page` margin box). The fix lives in the template's render path (`templates/resume/_html-helpers.ts`, which drives Playwright Chromium) — add `@page` CSS and keep `displayHeaderFooter` off
- **severity**: fail (this is the most obvious "this CV was machine-generated and not checked" tell)

### section_hierarchy_distinct
- **what**: section headings (## Professional Experience, ## Skills, etc.) visually stand out from body text — bigger, bolder, or with visible spacing above
- **how**: read page PNGs; judge whether headings look like headings or blend into body
- **auto_fix**: none — template-level concern (reference.docx or render.ts)
- **severity**: warn

### dates_visible_per_experience
- **what**: each experience block clearly shows its date range — not buried inline, not missing
- **how**: read each page PNG; verify dates appear near each company/role line
- **auto_fix**: none — content or template level
- **severity**: warn

### section_ordering
- **what**: every section must preserve the ordering strategy appropriate to that section. Experience is reverse chronological by end/start date; Highlights and Skills are ordered by target-fit/evidence priority; Education/Credentials are ordered by relevance to the resume positioning, with dates used only as tie-breakers.
- **how**: run `npm run resume:evaluate` for deterministic experience-date checks, then inspect composition JSON and rendered markdown/PDF for non-date sections. Confirm newly added fill content is inserted into the right priority position rather than appended at the bottom.
- **auto_fix**: reorder the relevant composition array without changing facts or provenance. For experience, sort by `end` descending then `start` descending, with `current` first; both featured blocks and compact mention rows must stay in chronological order within the Experience flow. For credentials, put the most role-relevant credential/training first, then supporting certifications, then foundational education when less differentiating.
- **severity**: fail for experience-date violations; warn/fail by judgement for relevance-ordered sections depending on whether the ordering misleads the reader.

### last_page_substantive
- **what**: if the CV spills onto a final page, that page must be at least 75% filled unless the source corpus is genuinely too thin after the full fill-up ladder. A 2-3 line orphan page is always suspect; a page that ends 50% down usually means the composition should absorb the spill or fill the page. The evaluator applies this as a global warning by default and a hard failure when the template or target declares `last_page_min_fill_pct`.
- **how**: read the last page PNG
- **auto_fix**: prefer fill-up when the user has more cv-source.md evidence to offer; prefer absorb when the existing featured-experience set is already substantive. Decide based on remaining target-fit material — if dropped/mention experiences score well, promote them rather than trim away strong content from earlier pages.
- **severity**: fail (was warn — tightened 2026-05-28 alongside whitespace_density)

### first_page_lead_strong
- **what**: page 1 carries the lead-with hook — name, contact, full Professional Summary visible, and ideally Highlights too. Reader should grok "who is this" in 5 seconds.
- **how**: read page 1 PNG; verify Summary block is fully visible (not just heading)
- **auto_fix**: if Summary truncated to page 2, consider trimming Highlights to make room
- **severity**: warn

---

## Per-template overrides

A template can extend or override universal checks by declaring its own `templates/resume/<name>/quality-checks.md`. Common reasons:
- The template fundamentally differs visually (e.g. minimalist might want different whitespace_density thresholds)
- The template adds checks unique to its design (e.g. a sidebar-using template might want "sidebar_balanced")
- The template SKIPS a universal check that doesn't apply (declare `<check-id>: skip`)

When both files declare a check with the same id, the per-template version wins. When per-template adds new checks, they augment the universal list.

resume-writer merges and reports both sources in its quality report.
