# Jev decision layer

Jev is the harness's live bounded semantic classifier. It is not a text generator and it never authorises an unattended send.

## Authority boundary

Deterministic code owns explicit fact extraction, arithmetic, scoring, hashes, state transitions, gates and execution. Jev selects from typed alternatives for discipline, evidence strength, resume positioning and genuinely ambiguous employment or arrangement terms. Existing generative agents retain writing, critique, research and nuanced evidence interpretation.

An automatic Jev decision may feed deterministic scoring and early queue placement. An unattended application requires a later automatic ClassificationV2 decision from the bounded in-agent verification path. Attended action still requires the person's fresh authority at the action point.

Operational queues follow the current decision, not historical momentum. If an unsubmitted row in `shortlisted`, package preparation, approval or `manual_action_needed` no longer has an automatic core-fit classification, deterministic reconciliation returns it to `discovered`. The row history, classification and any package remain retained for audit. Saved jobs are exempt because saving is an explicit order to apply.

## Result bands

- `automatic`: the bounded decision may feed deterministic scoring and early queue movement.
- `uncertain`: cannot enter or remain in an active queue; retained evidence is available for attended review or individual verification.
- `degraded`: no state application for the classification batch.
- `insufficient_input`: the source does not contain enough information for a semantic decision.

`state/profile/jev-policy.yaml` contains the model route, thresholds, live state-application switch and local spend cap. There is no production percentage rollout or canary path.

## Provider and provenance

Every provider or replay evaluation passes through `tools/jev/evaluate.ts`. Audit records include the call site, typed questions, full probability distributions, TypeSafe confidence metadata, requested and effective route, Gateway route identity, resolved model version when observable, latency, token usage, estimated cost, zero-retention request and fixture identity.

The Gateway is constrained to `typesafe-ai/jev` and has no model fallback. The pinned value identifies the route and transport only. Vercel currently returns the route alias rather than a resolved Jev version, and the harness reports that limitation without inventing a version pin.

Choice and Score confidence comes from `providerMetadata.typesafe.confidence`. Selected-option probability is distribution evidence, not confidence. Boolean questions retain their probability and have no separate confidence score. Full job-ad text is treated as untrusted data.

## Live, record and replay

Set `JEV_MODE` to:

- `live` for a Gateway call;
- `record` for a Gateway call plus an ignored local response fixture;
- `replay` to prohibit network access and require the matching fixture.

The normal daily front half uses live cached classification and applies healthy automatic results to the early pipeline. `npm run jev:classify -- --shadow` is a diagnostic dry path only. It does not represent the production architecture.

## Generative verification

The existing `jev:agent-fallback` command persists the same ClassificationV2 contract with source `agent_fallback` and records the Jev decision it supersedes. In the final architecture it has three bounded uses:

1. verify a positive Jev-selected candidate before unattended preparation or submission;
2. verify a user-saved job regardless of Jev certainty, because saving is an explicit order to apply;
3. review a high-scoring adjacent or platform-gap near miss selected by `npm run jev:verification-queue`;
4. recover one required row when Jev is unavailable or explicitly acknowledged as degraded.

It is not the batch classifier and it is never run over all Jev rejections. The near-miss parachute exists because the corrected production-rule metric found one historically submitted role that Jev would otherwise have dropped. It reviews only high-scoring adjacent or platform-gap rows with a credible resume match on an enabled one-click channel. It never bypasses the kill switch, channel, fit, critic, CV, content or submission gates.

## Expired openings

The daily front half runs deterministic expiry after ingestion and before any classification call. An active, unsent opening leaves the working pipeline when its explicit closing date has passed in the profile timezone, or the channel reports the advert expired. The current advert is re-read on each run so a stated extension replaces an older stored date. Posting age is not evidence. Submitted and later-stage rows remain as application history. See `docs/pipeline-state-machine.md` for the exact transitions.

## Degraded mode

Missing credentials, provider failure, timeout, a missing replay fixture or the daily spend cap creates a scoped `jev_degraded` audit event. A classification incident prevents all state application for that classification batch and blocks autopilot. Screening-match and fuzzy-dedup incidents are advisory because those paths already fail closed to deterministic or attended handling.

## Monitoring

The Guardrails Decision layer and benchmark files retain the before and after measurements, calibration labels, repeatability, cost and runtime comparisons. The live list excludes stale labels, while the audit evidence retains them. Critic Themes likewise shows only recurring findings shared by current blocked packages. These are operational regression monitoring, not an unfinished trial or a promotion queue.

Rerun the frozen benchmark whenever the effective model, route, question schema, thresholds, profile evidence or active resume set changes. Human labels remain bound to the exact role content and Jev decision. Stale labels are excluded rather than silently reused.

The final design and measured rationale are recorded in `docs/jev-integration-plan.md`.
