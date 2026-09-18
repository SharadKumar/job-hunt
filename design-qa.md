# Design QA: split decision workbench

Date: 2026-09-18

Reference: `/Users/sharad/.codex/generated_images/01a0b2b0-9dd7-73b0-b80c-2b20a0422105/exec-3d4d116c-5754-404e-aecf-4b6c23f3be1c.png`

Implementation: `https://job-hunt.localhost:8000/#/today`

## Comparison

- Structure: passed. Persistent dark navigation, live status bar, compact work queue and selected application detail follow the reference hierarchy.
- Workflow context: passed. The selected row keeps the six application stages visible, including the current branch and why it stopped.
- Interaction safety: passed. Banking a screening answer is separate from review and submission. The UI does not suggest an unsupported answer or press a send control.
- Information hierarchy: passed. The selected title, fit score, application state, question and recorded package checks read in the intended order.
- Visual language: passed. Flat surfaces, hairlines, quiet status colours, serif headings and system sans data preserve the reference character without external assets.
- Responsive behaviour: passed. At 390 px the selected workflow comes before the longer queue, the timeline wraps, and actions use the available width without horizontal overflow.
- Shared shell: passed. Pipeline and the remaining routes retain their existing content and inherit the same navigation and live operating status.

Intentional refinements from the reference:

- The existing quote remains because it is an established product preference.
- The status bar and queue counts come from live local state.
- Gate results are quoted from recorded files. Missing gates say not run.
- The answer control saves only. Review remains a separate deliberate action.

Final result: passed
