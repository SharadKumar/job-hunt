# Design QA: application workbench

Date: 2026-09-18

Reference: `/Users/sharad/.codex/generated_images/01a0b2b0-9dd7-73b0-b80c-2b20a0422105/exec-3d4d116c-5754-404e-aecf-4b6c23f3be1c.png`

Implementation: `https://job-hunt.localhost:8000/#/pipeline/needs` and `https://job-hunt.localhost:8000/#/resumes?selected=applied-ai`

Implementation screenshot: in-app browser captures at the implementation URLs. The browser did not expose filesystem paths for these captures.

Viewport: 1490 by 1054 for the direct reference comparison, plus 390 by 844 for the responsive pass.

Capture normalization: source 1490 by 1054 pixels, implementation 1490 by 1054 pixels, CSS viewport 1490 by 1054, density 1.

## Comparison

- Structure: passed. Persistent dark navigation, live status bar, grouped application browser and selected application detail follow the reference hierarchy.
- Workflow context: passed. The selected row keeps the six application stages visible, including the current branch and why it stopped.
- Interaction safety: passed. Banking a screening answer is separate from review and submission. Pipeline actions moved into the selected detail pane and retain their existing two-press guard where applicable.
- Action fidelity: passed. Needs you exposes Answer and retry or the external portal controls, Parked exposes Unpark, Sent follow-ups expose Mark responded, Replies expose the next outcome, and Closed exposes Reopen. The selected pane uses the server-resolved action in every segment.
- Information hierarchy: passed. The selected title, fit score, application state, question and recorded package checks read in the intended order.
- List fidelity: passed. Pipeline now uses the reference's compact grouped master list, selected-row rail and adjacent workflow pane rather than the previous full-width rows with embedded buttons.
- Visual language: passed. Flat surfaces, hairlines, quiet status colours, serif headings and system sans data preserve the reference character without external assets.
- Fonts and typography: passed. Serif display headings and system sans operational text preserve the source hierarchy, weight and compact wrapping.
- Spacing and layout rhythm: passed. The shell, header, workbench edges, selected rail, pane padding and hairline divisions retain the source rhythm across desktop, tablet and mobile.
- Colours and visual tokens: passed. Navy shell, warm paper, restrained blue selection and semantic verdict colours use the existing product tokens consistently.
- Image and asset fidelity: passed. This operational screen has no source imagery to reproduce. Resume page artefacts remain real protected files, represented by measured fill bars and explicit file actions rather than placeholders.
- Copy and content: passed. Labels describe the live harness states and recorded evidence without inventing a pass, approval or submission.
- Responsive behaviour: passed. At 390 px the selected workflow comes before the longer queue, the timeline wraps, and actions use the available width without horizontal overflow.
- Selection behaviour: passed. Choosing another row updates `selected` in the hash, keeps filters and the active segment, and refreshes the detail without losing list context.
- Resumes pattern: passed. Baselines now extend the selected design into three levels: the positioning browser, selected resume overview, and quality evidence for that exact render. The selected rail, flat surfaces, serif hierarchy and hairline divisions match the Pipeline workbench.
- Resumes interaction: passed. Selecting a positioning updates the address and refreshes both the resume overview and its quality evidence. Artefact access and guarded approval remain in the selected overview. Evidence questions remain profile-wide in their existing tab.
- Resumes responsive behaviour: passed. At 390 by 844 the selected resume comes first, quality evidence second, and the longer positioning list third. There is no horizontal overflow.

Comparison history:

- First implementation: failed. The selected direction was applied to Today, but Pipeline retained the older full-width application rows. This was the mismatch reported in review.
- Correction: passed. The source reference and the loaded live Pipeline were inspected side by side at the same viewport. Both now share the two-pane hierarchy, grouped compact rows, selected rail, six-stage workflow, question and gate context.
- Action audit: initially failed. The detail endpoint returned its action beside the row, while the shared controls expected it on the row. Parked, Closed and other selected-pane actions were therefore absent. The detail now joins that server action onto the selected row before rendering controls.
- Follow-up audit: initially failed. A submitted row and its enriched follow-up share an id, and the base row won selection. Sent now prefers the follow-up shape, preserving its days-since context and Mark responded action.
- Final live pass: passed. Needs you, Queue, Parked, Sent, Replies and Closed were checked against live local data. The Queue empty state, desktop layouts, 390 by 844 mobile order, horizontal overflow and browser console all passed. No workflow action was pressed.
- Resumes three-level pass: passed. The source reference and loaded Resumes workbench were inspected together at 1490 by 1054. A second pass at 390 by 844 confirmed the mobile reading order. Positioning selection, the Evidence questions tab and live quality context were checked without approving or opening an artefact.

Intentional refinements from the reference:

- Pipeline keeps its six real segments and compact filters above the workbench because they are live product controls absent from the reference mock.
- The status bar, segment counts and application rows come from live local state.
- Gate results are quoted from recorded files. Missing gates say not run.
- The answer control saves only. Review remains a separate deliberate action.

final result: passed
