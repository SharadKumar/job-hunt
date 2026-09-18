# Saved jobs are an order to apply

`AGENTS.md` section 2 is the contract; this page is the operational detail skills link to.

A job the person saved on the channel (SEEK `userSaved: true`) is an order to apply regardless of score, discipline band, location, employment type, clearance wording or duplicate status. Nothing parks a saved row on those grounds.

- Classify it like any other row (agent classification, full JD via `npm run seek:enrich` when the card is a blurb; if the classifier returns no positioning, assign the closest one), then draft and submit it.
- The letter names any gap honestly. The letter-critic still applies; the submission gate bypasses `red_flag_blocker` for saved rows.
- The retry set on every run is every saved row still on the live saved list that is not `submitted`, whatever its status. A saved row parked by an earlier critic block is re-drafted; a saved row `rejected` as a duplicate is reopened (`set-status discovered`, reason "user saved after rejection") and drafted.
- A letter-critic block on a saved row goes back to `cover-letter-writer` with the findings, up to two regenerations per row per run, before parking with the final findings in `notes`. The writer fixes the named sentences against the corpus; it never softens a disclosed gap. This is the one case where a letter is rewritten to satisfy the critic unattended.
- Only a non-Quick-Apply ad (external ATS) or an unknown screening question may leave a saved row unsent, and the note must say which.
- After a confirmed send, unsave the job on the channel (`npm run seek:unsave`).
