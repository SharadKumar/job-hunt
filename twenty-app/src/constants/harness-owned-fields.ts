import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';

import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';

// The single list of fields the harness writes. Role field restrictions are
// derived from it: the Owner may edit none of them, and on decision the
// Harness may edit only these.

// Objects the harness writes in full.
export const HARNESS_OBJECT_KEYS = [
  'opening',
  'application',
  'proposal',
  'document',
  'documentRevision',
  'screeningQuestion',
  'keywordQuestion',
  'positioning',
  'run',
  'escalation',
  'emailDraft',
  'control',
  'verification',
] as const satisfies readonly (keyof typeof OBJECT_IDS)[];

// Reverse relation fields hold no value of their own, so they never appear
// in a field restriction.
const REVERSE_RELATION_FIELDS: Record<string, readonly string[]> = {
  opening: [
    'applications',
    'proposals',
    'decisions',
    'escalations',
    'engagements',
    'screeningQuestions',
    'keywordQuestions',
  ],
  proposal: ['decisions'],
  document: ['revisions'],
  positioning: ['openings', 'decisions', 'keywordQuestions'],
};

const writableFieldIds = (objectKey: keyof typeof FIELD_IDS): string[] =>
  Object.entries(FIELD_IDS[objectKey])
    .filter(([name]) => !REVERSE_RELATION_FIELDS[objectKey]?.includes(name))
    .map(([, id]) => id);

// On decision the harness writes only the consume fields.
export const DECISION_CONSUME_FIELD_IDS = [
  FIELD_IDS.decision.consumedAt,
  FIELD_IDS.decision.result,
  FIELD_IDS.decision.resultReason,
] as const;

// Decision fields the person's button writes (everything but consume fields).
export const DECISION_PERSON_FIELD_IDS = Object.values(
  FIELD_IDS.decision,
).filter(
  (id) => !(DECISION_CONSUME_FIELD_IDS as readonly string[]).includes(id),
);

// objectUniversalIdentifier -> harness-owned field ids on that object.
export const HARNESS_OWNED_FIELD_IDS: Record<string, string[]> = {
  ...Object.fromEntries(
    HARNESS_OBJECT_KEYS.map((key) => [OBJECT_IDS[key], writableFieldIds(key)]),
  ),
  [OBJECT_IDS.decision]: [...DECISION_CONSUME_FIELD_IDS],
  // Proposals are written by agents (the harness, AI chat, Grok tools). The
  // fields an agent fills stay writable; who proposed it, its status and its
  // outcome belong to the harness, so a proposal can't confirm itself.
  [OBJECT_IDS.proposal]: [
    FIELD_IDS.proposal.proposer,
    FIELD_IDS.proposal.status,
    FIELD_IDS.proposal.outcome,
    FIELD_IDS.proposal.migratedAt,
  ],
  [STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier]: [
    FIELD_IDS.company.kind,
  ],
};
