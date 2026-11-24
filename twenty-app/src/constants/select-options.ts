// Option lists for SELECT fields. Values are UPPER_SNAKE; labels are sentence
// case. Opening statuses mirror VALID_TRANSITIONS in tools/pipeline.ts.

const option = <V extends string>(value: V, label: string, color: string) => ({
  value,
  label,
  color,
});

export const OPENING_STATUS_OPTIONS = [
  option('DISCOVERED', 'Discovered', 'gray'),
  option('AWAITING_EXTERNAL', 'Awaiting external', 'sky'),
  option('SHORTLISTED', 'Shortlisted', 'blue'),
  option('PARKED', 'Parked', 'brown'),
  option('DRAFTED', 'Drafted', 'iris'),
  option('AWAITING_APPROVAL', 'Awaiting approval', 'orange'),
  option('APPROVED', 'Approved', 'turquoise'),
  option('SUBMISSION_PENDING', 'Submission pending', 'amber'),
  option('SUBMITTED', 'Submitted', 'green'),
  option('RESPONDED', 'Responded', 'jade'),
  option('INTERVIEW', 'Interview', 'violet'),
  option('OFFERED', 'Offered', 'purple'),
  option('WON', 'Won', 'grass'),
  option('REJECTED', 'Rejected', 'red'),
  option('WITHDRAWN', 'Withdrawn', 'bronze'),
  option('MANUAL_ACTION_NEEDED', 'Manual action needed', 'crimson'),
] as const;

export type OpeningStatus = (typeof OPENING_STATUS_OPTIONS)[number]['value'];

export const ARRANGEMENT_OPTIONS = [
  option('REMOTE', 'Remote', 'green'),
  option('HYBRID', 'Hybrid', 'sky'),
  option('ONSITE', 'Onsite', 'orange'),
  option('UNKNOWN', 'Unknown', 'gray'),
] as const;

export const APPLY_METHOD_OPTIONS = [
  option('QUICK_APPLY', 'Quick apply', 'green'),
  option('EASY_APPLY', 'Easy apply', 'blue'),
  option('EXTERNAL', 'External', 'orange'),
  option('UNKNOWN', 'Unknown', 'gray'),
] as const;

export const PARKED_BY_OPTIONS = [
  option('USER', 'User', 'blue'),
  option('HARNESS', 'Harness', 'gray'),
] as const;

export const CRITIC_VERDICT_OPTIONS = [
  option('PENDING', 'Pending', 'gray'),
  option('PASS', 'Pass', 'green'),
  option('BLOCK', 'Block', 'red'),
] as const;

export const CV_MODE_OPTIONS = [
  option('BASELINE', 'Baseline', 'blue'),
  option('TAILORED', 'Tailored', 'purple'),
] as const;

export const PROPOSAL_TYPE_OPTIONS = [
  option('APPROVE_PACKAGE', 'Approve package', 'green'),
  option('ANSWER_SCREENING', 'Answer screening', 'blue'),
  option('CONFIRM_KEYWORD', 'Confirm keyword', 'sky'),
  option('REDRAFT_LETTER', 'Redraft letter', 'iris'),
  option('RESEARCH_COMPANY', 'Research company', 'turquoise'),
  option('PREP_INTERVIEW', 'Prep interview', 'violet'),
  option('DRAFT_FOLLOW_UP', 'Draft follow-up', 'purple'),
  option('RESCAN_CHANNEL', 'Rescan channel', 'amber'),
  option('SUGGEST_OUTCOME', 'Suggest outcome', 'orange'),
  option('UPDATE_DOCUMENT', 'Update document', 'brown'),
  option('DISCLOSURE', 'Disclosure', 'red'),
  option('OTHER', 'Other', 'gray'),
] as const;

export const PROPOSER_OPTIONS = [
  option('HARNESS', 'Harness', 'gray'),
  option('AI_CHAT', 'AI chat', 'purple'),
  option('GROK', 'Grok', 'blue'),
] as const;

export const PROPOSAL_STATUS_OPTIONS = [
  option('PROPOSED', 'Proposed', 'orange'),
  option('REQUESTED', 'Requested', 'sky'),
  option('CONFIRMED', 'Confirmed', 'blue'),
  option('DECLINED', 'Declined', 'gray'),
  option('DONE', 'Done', 'green'),
  option('FAILED', 'Failed', 'red'),
  option('REFUSED', 'Refused', 'crimson'),
] as const;

// Decision types. There is deliberately no retry action and no send action.
export const DECISION_TYPE_OPTIONS = [
  option('CONFIRM', 'Confirm', 'green'),
  option('DECLINE', 'Decline', 'gray'),
  option('APPROVE', 'Approve', 'green'),
  option('HOLD', 'Hold', 'brown'),
  option('REJECT', 'Reject', 'red'),
  option('WITHDRAW', 'Withdraw', 'bronze'),
  option('REOPEN', 'Reopen', 'sky'),
  option('UNPARK', 'Unpark', 'blue'),
  option('MARK_SENT', 'Mark sent', 'turquoise'),
  option('OUTCOME_RESPONDED', 'Outcome: responded', 'jade'),
  option('OUTCOME_INTERVIEW', 'Outcome: interview', 'violet'),
  option('OUTCOME_OFFERED', 'Outcome: offered', 'purple'),
  option('OUTCOME_WON', 'Outcome: won', 'grass'),
  option('OUTCOME_REJECTED', 'Outcome: rejected', 'red'),
  option('REQUEST_REDRAFT', 'Request redraft', 'iris'),
  option('EDIT_LETTER', 'Edit letter', 'iris'),
  option('APPROVE_BASELINE', 'Approve baseline', 'green'),
  option('START_ENGAGEMENT', 'Start engagement', 'grass'),
  option('ENABLE_AUTOPILOT', 'Enable autopilot', 'amber'),
  option('DISABLE_AUTOPILOT', 'Disable autopilot', 'gray'),
  option('HALT_SENDS', 'Halt sends', 'crimson'),
] as const;

export type DecisionType = (typeof DECISION_TYPE_OPTIONS)[number]['value'];

export const DECISION_RESULT_OPTIONS = [
  option('APPLIED', 'Applied', 'green'),
  option('REFUSED', 'Refused', 'red'),
] as const;

export const DOCUMENT_KIND_OPTIONS = [
  option('PROFILE', 'Profile', 'blue'),
  option('CV_SOURCE', 'CV source', 'green'),
  option('VOICE_RULES', 'Voice rules', 'purple'),
  option('VOICE_SAMPLES', 'Voice samples', 'violet'),
  option('SLOP_BANLIST', 'Slop banlist', 'red'),
  option('EDITORIAL_RULES', 'Editorial rules', 'orange'),
  option('EDITORIAL_BANS', 'Editorial bans', 'crimson'),
  option('LETTER_CRITIC_RULES', 'Letter critic rules', 'amber'),
  option('SCREENING_ANSWERS', 'Screening answers', 'sky'),
  option('CHANNELS', 'Channels', 'turquoise'),
  option('SCORING', 'Scoring', 'jade'),
  option('SUBMISSION_POLICY', 'Submission policy', 'brown'),
  option('POSITIONINGS', 'Positionings', 'iris'),
  option('KEYWORD_CLOUDS', 'Keyword clouds', 'cyan'),
  option('MARKET_CONFIRMATIONS', 'Market confirmations', 'mint'),
  option('KEYWORD_REJECTS', 'Keyword rejects', 'pink'),
  option('WORKSPACE_MANIFEST', 'Workspace manifest', 'gray'),
  option('OTHER', 'Other', 'gray'),
] as const;

export const QUESTION_STATUS_OPTIONS = [
  option('OPEN', 'Open', 'orange'),
  option('ANSWERED', 'Answered', 'green'),
  option('DISMISSED', 'Dismissed', 'gray'),
] as const;

export const KEYWORD_ANSWER_OPTIONS = [
  option('CONFIRM', 'Confirm and update source', 'green'),
  option('NOT_APPLICABLE', 'Not applicable', 'gray'),
  option('FAMILIARITY', 'Bring in as familiarity', 'sky'),
  option('PENDING', 'Unsure or keep pending', 'orange'),
] as const;

export const APPROVAL_STATUS_OPTIONS = [
  option('PENDING', 'Pending', 'orange'),
  option('APPROVED', 'Approved', 'green'),
  option('STALE', 'Stale', 'amber'),
  option('REJECTED', 'Rejected', 'red'),
] as const;

export const RESUME_VERSION_KIND_OPTIONS = [
  option('BASELINE', 'Baseline', 'blue'),
  option('TAILORED', 'Tailored', 'purple'),
] as const;

export const RUN_KIND_OPTIONS = [
  option('DAILY', 'Daily', 'blue'),
  option('HUNT', 'Hunt', 'turquoise'),
  option('PREPARE', 'Prepare', 'iris'),
  option('SUBMIT', 'Submit', 'green'),
  option('INTAKE', 'Intake', 'amber'),
  option('OTHER', 'Other', 'gray'),
] as const;

export const ESCALATION_PRIORITY_OPTIONS = [
  option('P1', 'P1', 'red'),
  option('P2', 'P2', 'orange'),
  option('P3', 'P3', 'gray'),
] as const;

export const ESCALATION_STATUS_OPTIONS = [
  option('OPEN', 'Open', 'red'),
  option('RESOLVED', 'Resolved', 'green'),
  option('DISMISSED', 'Dismissed', 'gray'),
] as const;

export const EMAIL_DRAFT_STATUS_OPTIONS = [
  option('DRAFT', 'Draft', 'gray'),
  option('IN_MAILBOX', 'In mailbox', 'blue'),
  option('SENT_BY_PERSON', 'Sent by person', 'green'),
  option('DISCARDED', 'Discarded', 'brown'),
] as const;

export const ENGAGEMENT_STATUS_OPTIONS = [
  option('ACTIVE', 'Active', 'green'),
  option('ENDED', 'Ended', 'gray'),
] as const;

export const VERIFICATION_RESULT_OPTIONS = [
  option('PENDING', 'Pending', 'gray'),
  option('PASS', 'Pass', 'green'),
  option('FAIL', 'Fail', 'red'),
] as const;

export const COMPANY_KIND_OPTIONS = [
  option('END_CLIENT', 'End client', 'blue'),
  option('AGENCY', 'Agency', 'orange'),
  option('PLATFORM', 'Platform', 'purple'),
] as const;
