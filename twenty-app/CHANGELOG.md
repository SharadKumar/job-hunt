# Changelog

All notable changes to this application are documented in this file.

## 0.1.6

- Give the Harness role the UPLOAD_FILE flag, so it can attach CVs, letters, screenshots and migrated archives to their records

## 0.1.5

- Add the Grok tools `brief`, `opening_summary`, `request_full_text` and `propose` (logic functions with tool triggers): summaries with rates and links only; full job description text only after a DISCLOSURE proposal logs the request; proposals only for allowlisted types
- Let the app role create proposals (the Grok tools' only write)
- Let the Harness role create engagements, for the Start engagement decision
- Add `grokDeliveredAt` to run, for the Grok digest

## 0.1.4

- Add the `notify-new-escalation` workflow: a new P1 escalation reaches the named member's inbox; migrated records never notify
- Add `resolvedAt` and `notifyMemberId` to escalation

## 0.1.0

- Initial application scaffolded with `twenty app init`
