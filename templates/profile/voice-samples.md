# Voice samples

The corpus `voice-check.ts` uses to compare cadence, sentence length, opener patterns, and vocabulary against drafts. The more representative the samples, the better the harness can mimic your writing and the fewer false-positive `cadence_drift` warnings on drafts that are actually fine.

**Don't put draft applications here.** Only your actual sent emails, LinkedIn posts, Slack messages, blog or other writing, and existing canonical content (CV summaries, resume notes) that you wrote in your own voice. Nothing the harness generated belongs in this file.

**Word-count guidance for representative samples**:
- Cover-letter cadence works best with at least 500 words of cover-letter-style prose in this file.
- DMs / Slack: at least 200 words of short-form back-and-forth.
- CV / long-form: at least 300 words of summary-style prose.

Redact recipients, client names and anything confidential. Only the cadence and word choice matter.

---

## Section A: Canonical content (long-form, mid-form)

Paste your current CV summary, career highlights and any per-positioning summaries you have written yourself. These give voice-check a long-form baseline from day one.

### A.1: CV master summary

```
[paste your CV summary here]
```

### A.2: CV highlights

```
[paste your career highlights here]
```

### A.3: Cover-letter reference (a real letter you sent and were happy with)

```
[paste one cover letter here]
```

---

## Section B: Short-form samples (USER ACTION needed)

**Cover-letter `cadence_drift` checks will keep warning on short conversational drafts until you add at least one of each below.** voice-check needs short-form samples to calibrate the cover-letter and DM kinds properly.

### B.1: Recent emails you've sent (target: 3-5 emails, at least 400 words total)

The most valuable samples: match the cadence you actually use in business correspondence.

```
[paste email 1 here]
```

```
[paste email 2 here]
```

```
[paste email 3 here]
```

### B.2: LinkedIn posts you've written (target: 2-3 posts, at least 200 words total)

Your public voice. These calibrate `outreach-drafter`'s LinkedIn comment and DM tone.

```
[paste post 1 here]
```

```
[paste post 2 here]
```

### B.3: Slack / DM messages (target: 4-6 messages, at least 150 words total)

Short conversational tone. Calibrates the recruiter-DM and follow-up nudge drafts.

```
[paste DM 1 here]

[paste DM 2 here]

[paste DM 3 here]
```

### B.4: Anything else you've written (blog, README, project notes)

Any longer-form your-voice content that isn't a CV summary. Bonus calibration data.

```
[paste sample here]
```

---

## How voice-check uses this file

- Reads everything (Section A and Section B).
- Computes a corpus baseline: average sentence length, openers used, dash density, spelling variant.
- For each draft kind (cover_letter, dm, comment, cv_bullet), compares draft cadence to BOTH the absolute targets in `references/voice/voice-rules.md` AND (when sufficient samples exist) the corpus baseline.
- **Graceful degradation**: if Section B is empty for a kind (e.g. no DMs yet), voice-check falls back to the absolute targets only; there is no `cadence_drift` warning purely because samples are missing.
