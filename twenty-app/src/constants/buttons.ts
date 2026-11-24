import {
  type DecisionType,
  type OpeningStatus,
} from 'src/constants/select-options';
import { type DecisionTarget } from 'src/types/decision-target';

type ButtonSpec = {
  label: string;
  target: DecisionTarget;
  // The decision type the button writes. Outcome picks one OUTCOME_* type
  // in its form, so it lists every type it may write.
  decisionTypes: readonly DecisionType[];
  // Headless buttons confirm in a modal; form buttons open a side panel to
  // collect a value first.
  mode: 'headless' | 'form';
  confirm?: {
    title: string;
    subtitle: string;
    confirmButtonText: string;
    accent: 'default' | 'blue' | 'danger';
  };
  // Field and values the command is shown for. Global buttons have none.
  availability?: { field: string; values: readonly string[] };
};

const opening = (values: readonly OpeningStatus[]) => ({
  field: 'status',
  values,
});

// Every button in the app. Each one writes exactly one decision.
export const BUTTONS = {
  proposalConfirm: {
    label: 'Confirm',
    target: 'proposal',
    decisionTypes: ['CONFIRM'],
    mode: 'form',
    availability: { field: 'status', values: ['PROPOSED'] },
  },
  proposalDecline: {
    label: 'Decline',
    target: 'proposal',
    decisionTypes: ['DECLINE'],
    mode: 'headless',
    confirm: {
      title: 'Decline this proposal?',
      subtitle: 'The agent will not carry it out.',
      confirmButtonText: 'Decline',
      accent: 'danger',
    },
    availability: { field: 'status', values: ['PROPOSED'] },
  },
  openingApprove: {
    label: 'Approve',
    target: 'opening',
    decisionTypes: ['APPROVE'],
    mode: 'headless',
    confirm: {
      title: 'Approve this package?',
      subtitle: 'The letter and CV as shown become the approved package.',
      confirmButtonText: 'Approve',
      accent: 'blue',
    },
    availability: opening(['AWAITING_APPROVAL']),
  },
  openingHold: {
    label: 'Hold',
    target: 'opening',
    decisionTypes: ['HOLD'],
    mode: 'headless',
    confirm: {
      title: 'Hold this opening?',
      subtitle: 'It is parked until you unpark it.',
      confirmButtonText: 'Hold',
      accent: 'default',
    },
    availability: opening(['DISCOVERED', 'SHORTLISTED']),
  },
  openingReject: {
    label: 'Reject',
    target: 'opening',
    decisionTypes: ['REJECT'],
    mode: 'headless',
    confirm: {
      title: 'Reject this opening?',
      subtitle: 'The harness stops working on it. You can reopen it later.',
      confirmButtonText: 'Reject',
      accent: 'danger',
    },
    availability: opening([
      'DISCOVERED',
      'AWAITING_EXTERNAL',
      'SHORTLISTED',
      'PARKED',
      'DRAFTED',
      'AWAITING_APPROVAL',
      'MANUAL_ACTION_NEEDED',
    ]),
  },
  openingWithdraw: {
    label: 'Withdraw',
    target: 'opening',
    decisionTypes: ['WITHDRAW'],
    mode: 'headless',
    confirm: {
      title: 'Withdraw from this opening?',
      subtitle: 'The harness records the withdrawal. You can reopen it later.',
      confirmButtonText: 'Withdraw',
      accent: 'danger',
    },
    availability: opening([
      'AWAITING_EXTERNAL',
      'SHORTLISTED',
      'PARKED',
      'DRAFTED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'SUBMISSION_PENDING',
      'SUBMITTED',
      'RESPONDED',
      'INTERVIEW',
      'OFFERED',
      'MANUAL_ACTION_NEEDED',
    ]),
  },
  openingReopen: {
    label: 'Reopen',
    target: 'opening',
    decisionTypes: ['REOPEN'],
    mode: 'headless',
    confirm: {
      title: 'Reopen this opening?',
      subtitle: 'It goes back to discovered and earns its way back.',
      confirmButtonText: 'Reopen',
      accent: 'default',
    },
    availability: opening(['REJECTED', 'WITHDRAWN']),
  },
  openingUnpark: {
    label: 'Unpark',
    target: 'opening',
    decisionTypes: ['UNPARK'],
    mode: 'headless',
    confirm: {
      title: 'Unpark this opening?',
      subtitle: 'It returns to the queue.',
      confirmButtonText: 'Unpark',
      accent: 'default',
    },
    availability: opening(['PARKED']),
  },
  openingMarkSent: {
    label: 'Mark sent',
    target: 'opening',
    decisionTypes: ['MARK_SENT'],
    mode: 'form',
    availability: opening(['APPROVED', 'SUBMISSION_PENDING', 'MANUAL_ACTION_NEEDED']),
  },
  openingOutcome: {
    label: 'Outcome',
    target: 'opening',
    decisionTypes: [
      'OUTCOME_RESPONDED',
      'OUTCOME_INTERVIEW',
      'OUTCOME_OFFERED',
      'OUTCOME_WON',
      'OUTCOME_REJECTED',
    ],
    mode: 'form',
    availability: opening(['SUBMITTED', 'RESPONDED', 'INTERVIEW', 'OFFERED']),
  },
  openingRequestRedraft: {
    label: 'Request redraft',
    target: 'opening',
    decisionTypes: ['REQUEST_REDRAFT'],
    mode: 'form',
    availability: opening(['DRAFTED', 'AWAITING_APPROVAL']),
  },
  openingEditLetter: {
    label: 'Edit letter',
    target: 'opening',
    decisionTypes: ['EDIT_LETTER'],
    mode: 'form',
    availability: opening(['DRAFTED', 'AWAITING_APPROVAL']),
  },
  positioningApproveBaseline: {
    label: 'Approve baseline',
    target: 'resumeVersion',
    decisionTypes: ['APPROVE_BASELINE'],
    mode: 'headless',
    confirm: {
      title: 'Approve this baseline CV?',
      subtitle: 'This exact version becomes the approved baseline.',
      confirmButtonText: 'Approve',
      accent: 'blue',
    },
    availability: { field: 'approvalStatus', values: ['PENDING', 'STALE'] },
  },
  openingStartEngagement: {
    label: 'Start engagement',
    target: 'opening',
    decisionTypes: ['START_ENGAGEMENT'],
    mode: 'headless',
    confirm: {
      title: 'Start an engagement?',
      subtitle: 'The harness creates the engagement for this win.',
      confirmButtonText: 'Start',
      accent: 'blue',
    },
    availability: opening(['WON']),
  },
  enableAutopilot: {
    label: 'Enable autopilot',
    target: 'global',
    decisionTypes: ['ENABLE_AUTOPILOT'],
    mode: 'form',
  },
  disableAutopilot: {
    label: 'Disable autopilot',
    target: 'global',
    decisionTypes: ['DISABLE_AUTOPILOT'],
    mode: 'headless',
    confirm: {
      title: 'Disable autopilot?',
      subtitle: 'Unattended one-click sends stop until you enable them again.',
      confirmButtonText: 'Disable',
      accent: 'default',
    },
  },
  haltSends: {
    label: 'Halt sends',
    target: 'global',
    decisionTypes: ['HALT_SENDS'],
    mode: 'headless',
    confirm: {
      title: 'Halt every send?',
      subtitle: 'A halt wins over any enable. Nothing is sent until you enable autopilot again.',
      confirmButtonText: 'Halt sends',
      accent: 'danger',
    },
  },
} as const satisfies Record<string, ButtonSpec>;

export type ButtonKey = keyof typeof BUTTONS;
