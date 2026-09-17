# Channel modules

A channel is a single source of job postings (and optionally a way to submit
applications back to it).

## Interface

All channels implement `HuntChannel` from `./_interface.ts`:

```ts
interface HuntChannel {
  id: ChannelId;
  search(config: SearchConfig): Promise<DiscoveredOpportunity[]>;
  submit?(opportunity: Opportunity, pkg: SubmitPackage): Promise<SubmitResult>;
}
```

Search-only channels return discovered opportunities; the harness handles dedup,
scoring, and ingestion. Channels with a `submit` implementation can be
opted into `auto_submit` in `state/profile/submission-policy.yaml`.
Channels without `submit` always land approved rows in
`manual_action_needed` so the user finishes the application themselves.

## Adding a channel

1. Create `tools/channels/<id>.ts` exporting a `HuntChannel`.
2. Add the channel to `state/profile/channels.yaml` (enabled, search config).
3. Add an npm script in `package.json` (`hunt:<id>`).
4. Run `npm run hunt:<id>` to smoke-test.
5. (Optional) Add `<id>-submit.ts` and wire it into the policy.

## Seeded modules

| Module | Search | Submit | Notes |
|---|---|---|---|
| `seek` | ✅ | ✅ `seek-submit.ts` (Quick Apply) | Primary AU job board. Playwright headless on the persistent signed-in Chrome profile `state/channels/chrome-profile/seek` (`npm run login:seek`). Also `seek:saved` (saved-jobs watcher) and `seek:unsave`. |
| `linkedin-jobs` | ✅ | ✅ `linkedin-submit.ts` (Easy Apply) | Rewritten 2026-09-16 against the logged-in SDUI layout. Persistent Chrome profile `state/channels/chrome-profile/linkedin` (`npm run login:linkedin`). `search --upsert` also enriches new rows (`linkedin:enrich`: full JD + `applyMethod` easy_apply / external). Easy Apply modal lives in a shadow root; the adapter handles multi-step and single-step variants, uploads the exact docx, answers screening questions from `screening-answers.yaml`, unticks "Follow", parks unknown questions. LinkedIn is retiring classic job search from Sept 2026: 0 cards with no login wall means re-probe the DOM. |
| `linkedin-posts` | stub | n/a | Scans feed for "hiring" posts; drafts only. |
| `hays`, `talenza`, `paxus`, `robert-half`, `peoplebank` | stubs | n/a | AU IT recruiters — search-only initially; Hays portal submit adapter planned. |
| `hn-who-is-hiring` | stub | n/a | Monthly thread parsing; always manual apply. |
| `wellfound` | stub | n/a | Off by default. |

## Login flow for authenticated channels

Run `npm run login:<channel>` — opens a headed Chromium, you log in, the
script saves `storageState.json` under `state/channels/storage-state/`.
Subsequent searches re-use that state. Cookies expire eventually — when a
search starts hitting login walls, the search will fail with a clear
"re-run login" message.

## Submit safety

Submit modules:
- Are in `*-submit.ts` files (denied by `.claude/settings.json` for non-interactive runs).
- Read screening questions from the rendered page, match against
  `state/profile/screening-answers.yaml`, halt on unknown questions.
- Capture a screenshot of the confirmation page to
  `state/pipeline/archive/<opportunity-id>/confirmation.png`.
- Are subject to per-channel `auto_submit` opt-in, the daily cap, and the
  global kill switch — all in `submission-policy.yaml`.

## SEEK Quick Apply (`seek-submit.ts`)

```
npm run submit:seek -- --id <opportunityId> --resume-file <path.docx> --cover-letter <path.md> [--dry-run] [--screenshot-dir <dir>]
```

Exit codes: `0` ok, `1` needsManual (external ATS, unknown screening question,
resumé mismatch, unexpected page), `2` error/usage. The result is printed as
`SubmitResult` JSON.

Steps driven: Choose documents (stored resumé selected by the exact
`--resume-file` basename, never the remembered default; "Write a cover letter"
textarea replaced wholesale) → Answer employer questions (optional) → Update
SEEK Profile → Review and submit (resumé filename verified under "Documents
included", required employer privacy checkbox ticked, "Show strong interest"
left off) → success page text captured as `confirmationRef`.

`--dry-run` stops on the review page, writes `<id>-review.png` and returns
`confirmationRef: "DRY RUN: review page verified"`. A real run writes
`<id>-success.png`; any failure writes `<id>-error.png`. Ads whose Apply link
leaves SEEK return `needsManual` with `reason: "external ATS: <host>"`.

### Screening answers: the `select` field

Entries in `state/profile/screening-answers.yaml` gain an optional `select`
list for choice questions (native select, radio group, checkbox group):

```yaml
- id: years_as_delivery_lead
  patterns:
    - "how many years.*delivery (lead|manager)"
  answer: "More than 10 years."          # used only for free-text questions
  select:                                # ordered regexes against option labels; first hit wins
    - "more than 10"
    - "10\\+"
    - "more than 5 years"
```

Without `select`, built-in defaults apply by question label: right to work →
`/australian citizen/i`; "how many years" → `/more than 5 years|10\+|more than 10/i`;
notice period → `/1 week/i`; clearance → `/no, ability to obtain|able to obtain|eligible/i`;
privacy consent → tick / `yes`. Free-text questions use `answer` (a `TODO`
answer counts as unknown). Anything unmatched halts before Continue and
surfaces as `newScreeningQuestion: { text, context }` where `context` is the
option labels joined with ` | ` (or `text` for a textarea).

## SEEK saved jobs

```
npm run seek:saved              # prints {saved, new, alreadyKnown, expired, ids, jobs}
npm run seek:saved -- --upsert  # upserts non-expired saved jobs with userSaved: true / userSavedAt
npm run seek:unsave -- --job <jobId>
```

The watcher walks every page of https://www.seek.com.au/my-activity/saved-jobs
(20 cards per page, "Next" link). Ids use the same `opportunityIdFor("seek",
https://www.seek.com.au/job/<id>)` scheme as search, so a saved job that search
already found only gains the `userSaved` flag; `upsert()` never rewinds status.

