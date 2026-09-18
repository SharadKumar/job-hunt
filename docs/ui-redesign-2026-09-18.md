# Local UI redesign: brief, design plan and screen contract

Written 2026-09-18 after a full browse of every screen, a code and data-model review, and a harness-flow and state-machine review. This is the contract for the implementation passes. It is generic: no person, employer or client is named here.

## Selected visual direction

The approved direction is a split decision workbench. On desktop, a persistent dark navigation rail and live status bar frame a compact Needs you queue beside the selected application. The selected detail keeps the six-stage workflow visible above the question, decision or portal action, followed by recorded package checks. On a phone, the selected workflow comes before the longer queue.

The original safety contract still applies. Saving a screening answer, reviewing a package and submitting it are separate actions. The interface never invents a gate verdict, suggests an unsupported answer or presses a send control. The implementation stays offline and dependency free; Tailwind-like spacing, control and breakpoint defaults are encoded in the shared CSS rather than adding a build step.

## 1. What the UI is for

One person, in the morning, after an unattended run. Their questions, in order:

1. What did the machine do under my name overnight, and did it finish?
2. What does it need from me, and how fast can I clear it?
3. Can I see exactly what was sent, and stop it if I have to?

Everything else (baselines, guardrails, run logs, settings) is reference. The UI is a morning brief with a work queue under it, not a dashboard.

## 2. What the review found

Browsing:

- Counts disagree between Home, the Sent list header and the filter column, because Home, the board and the row API each derive their own.
- The status filter on Applications is module state, not URL state, so a deep link lands on whichever bucket was last chosen, and scroll position carries across routes.
- The job description pane is a nested scroll trap on the row page.
- The UI speaks a fourth vocabulary (Blocked, To approve, Sending, In flight) beside the state machine's (manual_action_needed, awaiting_approval, submission_pending) and history entries mix both.
- Sent rows wear an "in flight" pill.
- Blocked mixes five different kinds of work (answer a question, redraft a letter, open a portal, decide a duplicate, a gate refusal) at one visual weight, and long reasons are truncated with an ellipsis.
- Runs has no real detail page; the detail is an accordion of raw journal markdown.
- Rules shows regexes and YAML paths as primary content.
- The visual system is the generic kit: Inter, greyscale tokens, identical bordered cards, one radius everywhere, green numbers for scores.

Code (file:line as of this date):

- `row.js:365` says nothing is sent from here on the same card that renders Retry now, which spawns `tools/autopilot-submit.ts` (`rows-ext-api.ts:896`, `jobs.ts:136`). `row.js:390` auto-clicks Retry now after a screening answer is banked.
- `row.js:103` invents a gate verdict from `status === "submitted"`.
- `app.js:207` fetches `api/...` relatively; `server.ts:252` serves the shell for every extensionless path, so deep URLs break every call.
- `resumes-api.ts:80` builds plain file URLs; with `HARNESS_UI_TOKEN` set every PDF, DOCX and thumbnail 401s.
- `row.js:205` memoises `GET /lanes` for the session; `applications.js:225` fills lane counts only after the awaiting tab is opened.
- Dead dispatch: `api.ts:604`, `:613`, `:678` shadowed by `rows-ext-api.ts:950`, `keywords-ext-api.ts:216`, `rows-ext-api.ts:1005`. `GET /api/jobs` and `GET /api/keywords/triage` have no client.
- `health-api.ts:699` falls through to `postScreeningRemove` for any unhandled route in its table.
- `channelLabel`, `needsYou`/`isInFlight`, `GATE_REFUSED` and `duration` are each implemented two or three times across client and server.
- CSS: `app.css` plus three wave files (`screens-a/b/c.css`); about forty selectors are defined twice with conflicting values.

Harness logic that the UI depends on:

- `sheets-sync.ts:83`: the UI Approve button maps to `approve -> null`, so the row does not move and the person sees no change.
- `rows-ext-api.ts:900`: Retry now requires `applyMethod` in {quick_apply, easy_apply}; SEEK rows carry no `applyMethod`, so every SEEK retry 409s.
- `rows-ext-api.ts:369`: the letter-blocked and duplicate branches run before the status branches, so Retry is offered on rows where `retry -> approved` is illegal.
- `api.ts:232`: `displayReason` never reaches `notes` when any moved history entry has a reason, hiding every capped, blocked and re-park note.
- `submission_pending` has no UI action and no path back to `approved` (`pipeline.ts:134`): a crashed adapter strands the row.
- `rescore-pipeline.ts:69` never re-evaluates a parked row, contradicting `docs/pipeline-state-machine.md`.
- `autopilot-submit.ts:265` runs the critic before the status walk, so a `shortlisted` row the critic blocks cannot be parked and is re-drafted every run; `:146` re-parks without history so the first reason stays on screen.
- `sheets-sync.ts:637` replaces `approval-queue.json` wholesale while the UI merges by id.

The last five are harness behaviour changes, not UI, and are recorded here for a separate decision. The first four are fixed in this redesign because the screens cannot be truthful without them.

## 3. Design plan

Subject: a private control room for one person's job hunt. The vernacular the harness already uses is operational (run, lane, gate, park, kill switch, in flight). The written journal and the daily summary are its native form. The memorable element is therefore **the brief**: Home opens with a short paragraph, set in a serif, whose numbers are live and link to the lists behind them. Everything under it is quiet, dense and list-shaped.

### Colour

| Token | Light | Dark | Role |
|---|---|---|---|
| `--paper` | `#ffffff` | `#0e0f11` | page |
| `--ink` | `#141414` | `#e8e6e1` | text, primary button fill |
| `--muted` | `#66655f` | `#9d9b94` | secondary text |
| `--rule` | `#dcdbd6` | `#2a2c30` | hairlines |
| `--wash` | `#f4f3ef` | `#17181b` | selected row, code, tag fill |
| `--you` | `#2337c6` | `#8fa0ff` | the person's lane: needs-you, links, primary action |
| `--pass` | `#1a7f3c` | `#4cc574` | machine verdict: pass, sent |
| `--fail` | `#b3261e` | `#f2685f` | machine verdict: fail, block, reject, kill switch |
| `--warn` | `#8a5a00` | `#d9a03a` | warn: worth a look |

Rules: `--you` is the only decorative colour and it means "your action". Verdict colours are used only for verdicts (gates, critic, run exit, sent). A score is a number in ink, tabular figures, never green.

### Type

Two families, no web font, nothing fetched.

- Voice: `ui-serif, "New York", "Iowan Old Style", Georgia, serif`. Page titles, the Home brief, ledes, section headings, empty states and confirmation copy. Line height 1.45, measure 62ch.
- Data: `-apple-system, "SF Pro Text", "Segoe UI", system-ui, sans-serif` with `font-variant-numeric: tabular-nums`. Rows, tables, buttons, forms, pills, history. Line height 1.4.

Scale (px): 13, 15, 17, 21, 27, 34. Weights: 400 and 600 only. No all-caps labels; small labels are sentence case at 13px in `--muted`. No numbered markers unless the content is a sequence (the row timeline is one).

### Layout

Max width 1080px, everything left aligned, 24px gutter. Lists are full-width rows separated by hairlines, not cards. A card (hairline box, 6px radius) is reserved for a distinct object the person opens or approves: a resume baseline, a run, a rule. Buttons: 4px radius, one primary per view region.

Home (Today):

```
Morning, <name>.                                     (serif 27)
Overnight the run sent 5 applications and stopped    (serif 17, live numbers
on 37. 7 need an answer, 12 are portals you open,     are links)
13 letters wait on a redraft, 2 need a decision.
Autopilot is on, 5 of 30 today. Next run Mon 07:00.

Needs you                                            (serif 21)
Answer a question (7)                                (group heading, sans 15)
  Title  Employer  Location  score   [Answer]  ...   (rows, hairlines)
Open a portal (12)
  ...
Decide (2)
Waiting on a redraft (13)          quiet, no button

Sent overnight (5)                 rows link to the row page
Replies (1)
Evidence questions (0)             one line, link
```

Pipeline (was Applications):

```
Pipeline                                        Sort  Score v
[Needs you 37] [Queue 0] [Parked 131] [Sent 90] [Replies 1] [Closed 24]
Channel: SEEK  LinkedIn  Recruiter     Min score [   ]     (chips, in URL)
--------------------------------------------------------------
group heading (when the segment groups)
Title  Employer  Location   lane  saved   score   reason (full)  [Action]
```

Row:

```
< Pipeline / Needs you
Title                                             [Primary action]
Employer, location, lane, apply method, saved by you
discovered > shortlisted > drafted > approved > sent > reply   (timeline, sans 13)

Why it stopped: <reason in full>                   (serif 17 lede, only when stopped)
Gates: Critic pass 0 warn | Letter critic fail 2 | Slop pass | Voice pass | Term grounding not run
[Cover letter                    ] [Job description         ]
[ ...                            ] [ collapsed to 12 lines,  ]
[ Edit  Redraft                  ] [ Show full description   ]
Screening (only when a question is unanswered)
Decision   Hold  Reject  Withdraw  (reason)
History
```

Schedules: list of runs as rows; `#/schedules/<date>` is a real page with sections Sent (linked rows), Stopped (grouped by kind), Numbers, and the raw log behind a disclosure.

### Principles

1. A count is never a dead end: every number links to the list it counts, and every list is the same query the count used.
2. One primary action per row, named by what will happen: Answer and retry, Open portal, Mark as applied, Redraft letter, Send now via autopilot, Reject as duplicate, Unpark.
3. Verdicts are quoted, never invented. A gate that has not run says not run.
4. The URL is the state: segment, channel chips, min score and sort live in the hash query; scroll resets on route change.
5. The machine's vocabulary is shown once, as a pill, and the person's vocabulary everywhere else. Status pills: Needs you, In queue, Being sent, Sent, Replied, Interview, Offer, Won, Parked, Rejected, Withdrawn.
6. Copy is truthful about sending. Where a button can cause a submission it says so, asks once, and is never pressed by code.

### Review against the generic default

The default for this brief would be a KPI tile row, a kanban, a blue accent, Inter and a card grid. This plan drops the tiles for a written brief, drops cards for hairline lists, drops Inter for the system serif and sans pair, keeps one accent and gives it a single meaning. The dark theme is kept. The rocket wordmark is kept as the only ornament.

## 4. Screen contract

### Header and navigation

- Nav: Today, Pipeline, Resumes, Schedules, Guardrails, and the cog. Old hashes (`home`, `applications`, `rules`, `queue`, `keywords`, `digest`, `runs`) redirect.
- Autopilot control stays in the header as a switch with its state in words: "Autopilot on, 5 of 30 today" linking to Settings. When the kill switch is on the switch is disabled and reads "Kill switch on".
- Active nav item is underlined in `--you`.

### Today (`#/today`)

- The brief (section 3). Each number is a link into the Pipeline segment or group it counts. Numbers come from one server call, `GET /api/summary`, which must return every count the brief and the Pipeline tabs use.
- Needs you and Sent overnight are peer tabs in the title row, with their live counts. The active tab is stored as `panel` in the hash query.
- Needs you: grouped by action kind in this order: answer a question, decide (duplicate, gate refusal, adapter uncertain), open a portal, waiting on a redraft (no button, quiet). Rows show title, employer, location, score, the full reason, one action. Its list and selected detail scroll inside the fixed desktop workspace.
- Sent overnight: rows submitted since the last run started in the left pane, with the selected application's recorded workflow and package in the right pane. It uses the same workspace rather than a second section below Needs you.
- Replies, Evidence questions and the last run line each one row.
- The quote of the day stays at the bottom of the persistent sidebar. Greeting is time-of-day plus name from the profile.
- Empty state for Needs you: "Nothing needs you. The next run is Mon 07:00."

### Pipeline (`#/pipeline/<segment>?channel=&min=&sort=`)

- Segments: needs (manual_action_needed), queue (shortlisted, drafted, awaiting_approval, approved, submission_pending), parked, sent (submitted), replies (responded, interview, offered, won), closed (rejected, withdrawn). Default segment is needs.
- Segment tabs carry counts from `GET /api/summary`. The list header count equals the tab count; a limit is shown as "showing 30 of 90, show all".
- Needs you groups rows by action kind with a heading per group. Queue shows the lane pill (Autopilot or You) and the machine status pill. Closed offers Reopen (to discovered).
- Row: title (link), employer, location, pills only for lane, saved by you and apply method. Score in ink, tabular, right aligned. Reason in full, wrapping. One action button, secondary style, primary style only for needs-you actions.
- Filters are chips and an input, all reflected in the hash query and restored from it.
- Stale row after an action: refetch the segment and the summary together.

### Row (`#/row/<id>`)

- Breadcrumb to the segment the row is in.
- Title, then facts line, then the timeline: the linear queue as steps (discovered, shortlisted, drafted, approved, sent, reply) with the current step filled in `--you`, a hold or exit shown as a labelled branch.
- Primary action top right, from the server's `action` only. Never derived on the client.
- "Why it stopped" lede in serif when the status is manual_action_needed or a gate refused, showing the newest reason (server fixes `displayReason`).
- Gates strip: one chip per gate with the recorded verdict or "not run". No verdict inferred from status.
- Letter card with Edit and Redraft letter. JD card collapsed to 12 lines with "Show full description"; no inner scroll region.
- Screening card only when a question is unanswered. Banking an answer enables, but never presses, "Send now via autopilot". That button confirms once ("This submits through <channel>. Send?").
- Decision card: Hold, Reject, Withdraw with a reason field; second press reads "Confirm reject" and so on.
- History: person's vocabulary in the step names, machine status in a muted pill after it, reason under.
- The sentence "Nothing is sent to a channel from here" appears only on cards where that is true.

### Resumes (`#/resumes`, `#/resumes/evidence`)

- Baseline cards keep their content; page-fill bars become a single row of four small bars with the percentage in ink; gates line reads "6 pass, 2 warn"; the critic line links to the findings.
- Evidence questions: the ledger as a list with the four fixed answers as buttons; the pending count links from Today.

### Guardrails (`#/guardrails`, was Rules)

- Standing rules first, plain language, Edit and Remove.
- Recurring critic themes second, with Promote to standing rule.
- Never-named patterns and editorial bans in a collapsed reference section, described in words with the pattern in a code span, and a line saying which file to edit.

### Schedules (`#/schedules`, `#/schedules/<date>`)

- List: date, sent, stopped, duration, exit as a verdict pill.
- Detail page: Sent (linked rows), Stopped (grouped by kind, each linked), Numbers, and the raw summary and log behind a disclosure. Work still running shows as its own state.

### Settings (`#/settings`)

- Token, kill switch (confirm once), schedule and channel sign-in state, notify URL. The harness health block moves to Today's last line and Schedules.

## 5. Implementation packages

Foundation (first): tokens, type, layout primitives and list/row/pill/button classes in `app.css`; delete `screens-a/b/c.css` and move what survives into one file per screen; router with query-string state, scroll reset, absolute `/api` paths; nav rename and redirects; `GET /api/summary` returns every count; shared `channelLabel`, `statusLabel`, `duration` and `laneLabel` helpers exported from `app.js` and mirrored in one server module.

Then in parallel:

- Today and Schedules.
- Pipeline and the row API fixes (Approve moves the row, Retry keyed off the lane, letter-blocked and duplicate branches gated by status, `displayReason` newest-wins, dead dispatch removed, screening route fall-through fixed).
- Row page.
- Resumes, Evidence, Guardrails, Settings, and tokened file links.

Last: typecheck, tests, a browser pass at 1280 and 400 wide with screenshots, and a duplicate-selector audit.

Every pass runs `npm test` before it returns and reports the exit code, not a summary.

## 6. Component-level fixes (from the screenshots)

These are as binding as section 4. Each screen agent fixes every item in its screen and every global item that its screen renders.

### Global components

- Pills: one grey pill is used for channel, apply method, saved by you and in flight, so nothing is told apart. Channel is text in the meta line, not a pill. Pills exist only for: lane (You / Autopilot), saved by you, apply method when it decides the lane (Quick Apply, Easy Apply, External, Unknown), and status. A submitted row never wears an in-flight pill.
- Dates: four formats are in use (17 Sep, 08:19; 2026-09-17; Fri 18 Sep, 07:00; 18 Sep). One helper, `when(iso)`: today shows "08:19", this week "Tue 08:19", this year "17 Sep", otherwise "17 Sep 2025". Full timestamp in a title attribute.
- Buttons: three sizes and four styles are mixed inside one list. One height (32px) in lists, one (36px) on detail pages. Primary (ink fill) for the person's action; secondary (hairline) for everything else; destructive is a secondary button with `--fail` text, never red text alone. A button label is a verb phrase that names the outcome.
- Numbers: scores, counts and exit codes are set in ink with tabular figures. Green is for pass and sent only. The green count beside a critic theme, the green score, the green exit 0 all go.
- Card headings at 15px bold over 13px grey body is too much small grey text. Body is 15px ink; 13px `--muted` is for a single meta line under a title, nothing more.
- No all-caps eyebrow labels (CRITIC, GATES, PACKAGE, MOVE THIS APPLICATION, STATUS, CHANNEL, MINIMUM SCORE). Sentence case, 13px, `--muted`.
- Ellipsis truncation is banned for reasons and notes. Wrap, or put the full text under a disclosure with the first line visible.
- Every card of the same kind has the same fill. The Evidence questions card on Home is grey while its neighbours are white.
- Column layouts must not leave a hole: the two-column Home leaves a third of the left column empty under To approve. Use a single column with full-width sections, or a sidebar of fixed narrow width for the reference bits.

### Today (Home) cards

- Harness card mixes a prose sentence, a bold verdict, a next-run line and two tiny sign-in lines at three sizes. Becomes the brief plus one line: "Last run Fri 07:00, finished cleanly in 1 h 46 m. Next run Mon 07:00. SEEK and LinkedIn signed in today."
- Blocked card: title and employer share a line so long titles wrap under the employer; the reason sits in 13px grey; the last item is a bare "32 more on the Applications screen" sentence. Becomes list rows (title, employer and location on the meta line, full reason, one action) with a "Show all 37" link that opens the Pipeline segment.
- To approve is a big number tile ("0" at 34px with a caption). Big-number tiles go. It becomes a line in the brief and a group in Needs you.
- Sent today says "2 applications sent today." above a list of 2, while the Harness card says 5 of 30. One number, from the summary, and it is the same number on both lines.
- Resumes card: six rows each with a green "approved 11 Sep" pill of varying width. Becomes one line per resume: name, then "approved 11 Sep" in muted text, aligned in a two-column grid so the dates line up.
- Recurring critic themes: green count on the left. Becomes theme name, count in ink on the right, linked to Guardrails.
- Latest run: one line, duplicate of the Harness line. Merge into the brief.

### Pipeline (Applications) rows and filters

- Meta line wraps so a lone pill orphans on line two ("easy apply", "in flight"). Structure each row as a grid: title cell (title, then a meta line: employer, location, apply method), pills cell, score cell, and a full-width reason line; the action cell is vertically centred on the row, not floating at the bottom right.
- Score floats at the top right with no baseline relationship to the title. Right-align it on the title baseline.
- Two actions side by side (Open portal, I applied myself) at different weights. Primary is the one the person most likely does; the other is secondary; never two primaries.
- "Reject" as red text in a hairline button reads as a link. Use the destructive button style.
- Filter panel: radios with counts, checkboxes, a "Minimum score" input with placeholder "Any", and a "Sort" select whose label sits off the baseline. Replace the panel with the segment strip (tabs with counts), a chip row for channel, an inline min-score input, and a sort select whose label is inline and baseline aligned. On narrow screens the strip scrolls horizontally.
- The follow-ups panel inside Sent is a bordered inner list with its own row style, its own "Mark responded" buttons, a full-width "Show all 20" button and a footnote. Becomes a group heading "No reply after 7 days (20)" above rows in the same list style, with "Mark responded" as the row's action and "Show all" as a text link on the heading line.
- Header count "30 rows" against a filter count of 90 for Sent. Header reads "Showing 30 of 90" with a "Show all" link.

### Row page

- Facts line mixes facts and status in a comma list ("…, score 87, remote, easy apply, blocked."). Status leaves this line and goes to the timeline and the status pill; the facts line is employer, location, arrangement, apply method, with "Open the advert" as the last item.
- The three top cards (Critic, Gates, Package) are equal-width tiles with all-caps eyebrows and cramped text ("Slop pass. Voice pass. Term grounding not recorded."). They become a single gates strip of chips, each chip "Critic pass, 0 warn", "Letter critic fail 2", "Slop pass", "Voice pass", "Term grounding not run", and a package line under it ("Baseline CV, letter 269 words, 8 files", the CV filename as a link).
- Cover letter card: two header buttons, then a long letter. Header buttons stay; the letter is set at 15px with the measure limited to 62ch.
- Job description card scrolls inside itself. No inner scroll region anywhere in the app: collapse to 12 lines with "Show full description".
- Screening answers card holds two unrelated forms (answer this question; years with a skill) plus a "10 banked answers" disclosure. Split: the question form is the card; "Years with a skill" and the banked answers move into one "Answer bank" disclosure at the bottom of that card. Field labels at 13px `--muted` sit directly above the field with 4px gap.
- Decision card: all-caps eyebrow, three same-weight buttons with red text, an input labelled "Reason (goes into the history)", and a footnote about pressing twice. Becomes: Hold (secondary), Reject and Withdraw (destructive secondary), a reason field labelled "Reason", and the confirm state on the button itself ("Confirm reject").
- History: red dots for any move into blocked, mixed vocabularies ("sending to blocked", "approved to sending"), a trailing "more" link. Becomes: person's vocabulary ("Sent for approval", "Stopped: question unanswered"), the machine transition in a muted pill after it, the reason in full under it, no coloured dots (a hairline spine only), and the newest entry first.

### Resumes cards

- Four tall thin bars with "fill 88%" labels are unreadable and the red bar at 88% reads as a fail. Becomes one horizontal row of four short bars with the page number under each and the percentage in ink; a page under the 90% floor gets a `--warn` label, not red.
- "rendered 2026-09-17" beside "Approved 11 Sep" mixes date formats. Use `when()`.
- "Gates: 6 pass, 2 warn, 0 fail details", "needs review: 7 findings run /resume-review" and "12 clouds, 0 stale." are three lines of jargon. Becomes: a verdict line "Gates: 6 pass, 2 warn" with the warns as a disclosure; a critic line "7 findings to review" linking to the findings; and "Keyword clouds: 12 current" with "stale" only when non-zero.
- must-have and renderable progress bars get their labels on the same line as the bar with the fraction in ink.
- Three same-weight file buttons. PDF is primary, DOCX and Markdown are secondary, all three tokened.
- The grey footer paragraph about resume:approve moves into the empty state and the approve confirmation only.

### Guardrails (Rules)

- Standing rules are long paragraphs in a numbered list at a narrow measure with the right half of the card empty, and Edit / Remove under each. Becomes full-width rows: rule text at 62ch, Edit and Remove aligned right on the first line.
- The recurring theme block nests a bordered finding box inside the card with a "Promote to standing rule" button beside it. Becomes: theme name and count, the description, the sample finding as a quotation, and the Promote button on the heading line.
- Never-named entries show the regex in a code pill as the primary text with the fix line in `--you` colour that looks like a link but is not. Becomes description first, the pattern in a code span after it, the fix in `--muted`; nothing is coloured `--you` unless it is a link or an action.
- Editorial bans: same treatment, collapsed by default.

### Schedules

- List rows: "took 59 m 17 s" and "1 h 46 m" and "no summary written" mix. Use `duration()`. "no summary written" becomes a muted "no summary".
- "exit 0" in green and "exit 1" in red as bare text. Becomes a verdict pill: "Finished" (pass), "Failed, exit 1" (fail), "Running" (you).
- The expanded accordion dumps raw markdown. The detail page structures it (section 4).

### Settings

- API token card: three same-weight buttons (Save, Clear, Show). Save is primary; Show becomes an eye toggle inside the field; Clear is destructive secondary.
- Safety card: a red left border, a paragraph and an outlined red button. Becomes a plain card with the state as the first line ("Kill switch is off") and a destructive secondary button that confirms once.
- Harness block: key and value pairs with tiny grey file paths under some values. File paths move into a title attribute; the block is a two-column definition list with 13px keys and 15px values.
- How to run: a code block with comments in it. Keep, but the trailing "This browser is using …" and "Docs: README" lines become one muted line.

## 7. Component anatomy, states and copy (binding)

Spacing scale: 4, 8, 12, 16, 24, 32, 48. Nothing else. Vertical rhythm between sections is 32, between a heading and its list 12, between rows 0 (the hairline is the gap), inside a row 12 top and bottom.

### List row (`.list-row`)

Grid: `grid-template-columns: 3ch minmax(0,1fr) auto; column-gap: 16px`. The score leads (a ranked list scans as a column of numbers), the text is the middle column, and the actions are a right rail as wide as the widest button, top aligned with the title, stacked at one width when there are two, padding 12px 0, hairline below. Cells:

1. Main cell. Line 1: title, 15px, weight 600, ink, a link (hover underline, focus ring). Pills follow the title on the same line with 8px gap and wrap as a group, never singly (wrap the pills in one `inline-flex` span with `white-space: nowrap` and let the whole group drop). Line 2 (meta): 13px muted, employer, location, apply method, separated by two spaces and a middle-height "," not a dot: "Employer, Sydney NSW (Hybrid), Easy Apply". Line 3 (reason): 15px ink, full text, `overflow-wrap: anywhere`, present only when there is a reason.
2. Score cell: 15px, tabular, ink, right aligned, `align-self: start`, top padded 1px so it sits on the title baseline.
3. Action cell: `align-self: center`, one button, or nothing. On narrow screens the grid becomes one column and the button is full width under the reason.

Hover: `background: var(--wash)` only when the whole row is a link (Schedules list, Resumes list). Rows with buttons do not change on hover. Selected or current row (e.g. the row you just acted on): 2px left border in `--you` for 3 seconds, then off.

### Pill (`.pill`)

Height 20px, padding 0 8px, 13px, radius 10px, `--wash` fill, ink text. Variants: `.pill-you` (text and 1px border in `--you`, no fill), `.pill-autopilot` (muted text, hairline border), `.pill-status` (wash fill, ink), `.pill-pass` / `.pill-fail` / `.pill-warn` (text in the verdict colour, 1px border same colour, no fill), `.pill-none` (muted text, hairline, for "not run"). Never two fills of colour side by side. Pills are never links.

### Button (`.btn`)

Height 32px in lists, 36px on detail pages, padding 0 12px, 15px, weight 600, radius 4px, hairline border, ink text, paper fill. `.btn-primary`: ink fill, paper text. `.btn-danger`: hairline border, `--fail` text; on hover the border takes `--fail`. Disabled: 50% opacity, `cursor: not-allowed`, keeps its label. Busy: label becomes the present participle ("Sending", "Saving") with `aria-busy`, width locked so the row does not jump. Confirm state (destructive or sending): the same button, label becomes "Confirm reject" / "Confirm send", takes the primary style, and a "Cancel" text button appears beside it; Escape cancels; the state expires after 8 seconds. No native `confirm()` dialogs anywhere.

Labels, exact: Answer and retry; Open portal; Mark as applied; Redraft letter; Send now via autopilot; Reject as duplicate; Send anyway; Unpark; Approve; Hold; Reject; Withdraw; Reopen; Mark responded; Interview; Offer; Won; Edit letter; Save letter; Cancel; Bank answer; Not a real question; Save years; Promote to standing rule; Edit; Remove; Save token; Clear token; Turn kill switch on; Turn kill switch off.

Toast after an action names the outcome in the same words as the button: "Rejected", "Sent via autopilot: SEEK confirmed", "Answer banked". 4 seconds, bottom left, one at a time, `role="status"`.

### Segment strip (`.segments`)

Horizontal list of links, 15px, padding 8px 0, gap 24, hairline under the strip. Each item: label then count in tabular muted ("Needs you 37"). Active item: ink, 2px underline in `--you`, `aria-current="page"`. Zero count stays visible, muted. On narrow screens `overflow-x: auto`, no wrap, scroll-snap.

### Chips (`.chips`)

Toggle buttons 28px high, 13px, radius 14px, hairline border; selected: ink fill, paper text, `aria-pressed="true"`. The min-score field is a 64px wide number input with an inline label "Min score" to its left, baseline aligned; the sort select has an inline label "Sort" the same way. All of it on one line under the strip with 16px gaps; wraps as a group under 720px.

### Card (`.card`)

Hairline border, radius 6px, padding 16px, paper fill, no shadow. Heading 17px serif weight 400, margin bottom 12. Card header actions right aligned on the heading line (`display:flex; justify-content:space-between; align-items:baseline`). Cards never nest.

### Brief (`.brief`)

Serif 17px, line height 1.45, measure 62ch, paragraphs 12px apart. Numbers inside are links: ink, underline in `--you` 1px offset 3px, tabular; hover fills the underline to 2px. A zero number is plain text, not a link. Sentences are composed from the summary with correct plurals and never print "0 need an answer": omit the clause when the number is zero, and if every clause is zero the paragraph reads "Nothing needs you."

### Timeline (`.timeline`)

Steps as an ordered list, horizontal, 13px sans: discovered, shortlisted, drafted, approved, sent, reply. Each step: an 8px dot on a 1px hairline spine and the label under it. Done steps: ink dot; current: 10px dot in `--you` with the label in `--you` weight 600; future: hairline dot, muted label. A hold or exit (parked, manual_action_needed, rejected, withdrawn) renders as a branch under the step it left, labelled in the person's vocabulary ("Stopped: question unanswered"). Under 720px the timeline wraps to two lines, no horizontal scroll.

### Gates strip

One row of pills with 8px gaps, 13px, followed by a package line in 13px muted. Chip text is "Name verdict, detail": "Critic pass, 0 warn", "Letter critic fail, 2 findings", "Slop pass", "Voice pass", "Term grounding not run". Clicking a fail or warn chip scrolls to the findings on the page (letter critic findings render under the letter). Verdict source is the recorded file only.

### Form fields

Label 13px muted, 4px above the field; field 36px high, 15px, hairline border, radius 4px, padding 0 10px, focus ring 2px `--you` offset 2px; help text 13px muted 4px under; error text 13px `--fail` replacing the help text and `aria-describedby`. Enter submits the single-field forms (screening answer, reason, token). A number field shows its unit in the label ("Years"). Placeholders are examples, not instructions ("e.g. 4"), and never the only label.

### Disclosure (`.disclosure`)

Native `<details>` with a summary styled as a text link in ink with a small chevron that rotates; summary copy names the thing and the count ("Show full description", "Answer bank, 10 answers", "18 single findings", "Raw log"). Open state persists per row in `sessionStorage`.

### Empty states

Serif 17px, ink, one sentence saying what would put something here and the next thing to do, with a link when there is one. Examples: "Nothing needs you. The next run is Mon 07:00." "Nothing parked. Rows land here when a role is interstate and the ad does not say it is flexible." "No runs yet. Start one with npm run daily."

### Loading and errors

First load of a screen: the page title renders immediately and the list area shows three placeholder rows at 40% opacity, no spinner, no "Loading." text. An action refetches the list and the summary together and swaps in place without scrolling. API failure: an inline hairline box at the top of the list, 15px, "Could not load the pipeline: <message>. Retry." with Retry as a text button; never a toast for a load failure. A 401 anywhere routes to Settings with the token field focused and the message "This server needs the API token."

### Keyboard and focus

Every interactive element has a visible 2px `--you` focus ring. Tab order follows the visual order. In a list, the row title is the first tab stop, the action button the second. On the row page the primary action is the first tab stop after the breadcrumb. `Escape` closes a confirm state and collapses an open letter editor without saving (asks once if the text changed). No global single-key shortcuts.

### Responsive

Breakpoints: 720 (one column, stacked rows, full-width buttons, segments scroll) and 960 (row page goes to two columns for letter and JD; Today stays one column). Header under 720: wordmark, a "Menu" button that toggles the nav as a vertical list, the autopilot switch stays visible as a dot plus "On"/"Off". Tap targets are at least 40px high on touch devices (`@media (pointer: coarse)`).

### Accessibility

`aria-current` on active nav and segment; `role="status"` on the toast; list groups are `<section>` with an `<h3>`; the timeline is an `<ol>` with `aria-label="Progress"`; verdict pills carry the verdict word in text, never colour alone; contrast of every text on paper and on wash is at least 4.5:1 in both themes (verify `--muted` and `--warn` on `--wash`).

### Copy rules

Sentence case everywhere. No exclamation marks. No "please". No "successfully". Second person for the person, "the run" for the machine, "autopilot" for the lane. A status is always one of the words in principle 5 of section 3. A time is always from `when()`. A duration is always from `duration()`. Channel names are SEEK, LinkedIn, Recruiter, HN.
