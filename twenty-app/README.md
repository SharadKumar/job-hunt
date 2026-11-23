# Job hunt (Twenty app)

The Twenty app for the job-hunt harness. It defines the workspace the harness
uses as its store and the person uses to confirm what agents propose.

## What it defines

- Objects: opening, application, proposal, decision, document and document
  revision, screening and keyword questions, positioning, run, escalation,
  email draft, engagement, control and verification. Company gains a `kind`.
- Roles: Owner (the person), Harness and Grok (API keys), No access, and an
  app role that lets buttons read and create decisions.
- Views and a Job hunt sidebar section, with a Today page.
- Buttons on openings, proposals and positionings, plus global switches for
  autopilot. Each button writes exactly one create-only decision; the harness
  applies it. No button sends anything.

## Develop

Setup instructions live in [SETUP.md](SETUP.md). The app has its own
`yarn.lock` and is not part of the root npm workspace.

```bash
yarn install
yarn test:unit                         # unit tests, no server needed
npx tsc --noEmit -p tsconfig.spec.json # typecheck
twenty app apply --remote <test-remote> # apply to a test workspace
```

Universal identifiers in `src/constants/universal-identifiers.ts` are stable:
never regenerate or edit an existing value.

## Learn more

- [Twenty Apps documentation](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [Twenty CLI reference](https://docs.twenty.com/developers/extend/apps/operations/cli)
