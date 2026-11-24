// What the Grok tools may do (plan F15). Grok is an untrusted caller: every
// tool returns summaries only, and the only writes are proposals.

// Proposal types Grok may create. A copy of the EXECUTORS keys in the
// harness's tools/decisions/proposals.ts; a unit test keeps the two equal.
// DISCLOSURE is never here: only request_full_text writes it, as its log.
export const GROK_PROPOSAL_TYPES = [
  'REDRAFT_LETTER',
  'DRAFT_FOLLOW_UP',
  'RESEARCH_COMPANY',
  'PREP_INTERVIEW',
  'RESCAN_CHANNEL',
  'ANSWER_SCREENING',
  'CONFIRM_KEYWORD',
  'APPROVE_PACKAGE',
  'SUGGEST_OUTCOME',
  'UPDATE_DOCUMENT',
] as const;

export type GrokProposalType = (typeof GROK_PROPOSAL_TYPES)[number];

// Openings in the apply queue, as brief() reports them.
export const GROK_QUEUE_STATUSES = ['SHORTLISTED', 'AWAITING_APPROVAL'] as const;

export const GROK_LIMITS = {
  // Rows per list in brief().
  listSize: 20,
  // Characters kept from any free text a summary carries.
  summaryText: 300,
  // Longest reason or brief accepted from Grok.
  reason: 500,
  brief: 2000,
  // Open Grok proposals at once; further ones are refused until the person
  // confirms or declines some, so a caller can't flood the inbox.
  openProposals: 20,
} as const;
