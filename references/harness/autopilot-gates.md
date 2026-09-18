# Autopilot gates

`AGENTS.md` section 2 is the contract and the only normative statement of send authority. This page exists so skills and agents can link to the gate list instead of restating it, and so a change lands in one place.

An unattended run may submit only through `npm run autopilot:submit`, only on a channel listed in `autopilot.channels` in `state/profile/submission-policy.yaml` (one-click adapters: SEEK Quick Apply via `tools/channels/seek-submit.ts`, LinkedIn Easy Apply via `tools/channels/linkedin-submit.ts`), and only when every gate below passes:

- `autopilot.enabled: true` and `kill_switch: false`
- status `approved`, agent classification present (`classification._classifier: "agent"`), core discipline **or** a job the person saved on the channel
- no `red_flag_blocker` (bypassed for saved jobs)
- baseline CV approved and unchanged since approval
- `tools/letter-critic.ts` pass on the exact letter (sha256 matched against `cover-letter.md`)
- `slop-killer`, `voice-check` and `resume-lint-ats` pass
- `autopilot.max_per_day` not reached

`tools/autopilot-submit.ts` runs the critic and then `tools/submission-gate.ts` with `--approved-by autopilot:<run-id>`; the gate, not the calling skill, is the authority. Every other channel, every external ATS, every recruiter or hiring-manager message and every LinkedIn comment or DM is attended or draft-only (`AGENTS.md` section 2, attended lane).

Outcomes: gate `gate_failed` / `manual` / `duplicate`, an external-ATS redirect, an unknown screening question, a letter-critic block or an adapter failure park the row in `manual_action_needed` with the reason in `notes`. Gate `blocked` (kill switch) or `capped` leaves the row at `approved` for a later run and stops submitting for the day.
