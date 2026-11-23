import {
  defineWorkflow,
  StepLogicalOperator,
  ViewFilterOperand,
} from 'twenty-sdk/define';

import { OBJECT_IDS, WORKFLOW_IDS } from 'src/constants/universal-identifiers';

const W = WORKFLOW_IDS.notifyNewEscalation;
const GROUP = 'all-routing-conditions';
const after = (field: string) => `{{trigger.properties.after.${field}}}`;

// Plumbing only (plan Principle 7): when the harness creates an escalation it
// marked P1, tell the member it named in their inbox. The workflow reads the
// routing fields the harness set and decides nothing. Migrated records never
// notify (R31). Slack delivery needs a secret, so the harness posts that
// itself (the recorded exception).
export default defineWorkflow({
  universalIdentifier: W.workflow,
  name: 'notify-new-escalation',
  version: {
    trigger: {
      universalIdentifier: W.trigger,
      type: 'DATABASE_EVENT',
      settings: { objectUniversalIdentifier: OBJECT_IDS.escalation, action: 'created' },
      nextStepIds: [W.filter],
    },
    steps: [
      {
        universalIdentifier: W.filter,
        name: 'Only new P1 escalations',
        type: 'FILTER',
        input: {
          stepFilterGroups: [{ id: GROUP, logicalOperator: StepLogicalOperator.AND }],
          stepFilters: [
            { id: 'priority-is-p1', type: 'SELECT', stepOutputKey: after('priority'), operand: ViewFilterOperand.IS, value: '["P1"]', stepFilterGroupId: GROUP, positionInStepFilterGroup: 0 },
            { id: 'not-migrated', type: 'DATE_TIME', stepOutputKey: after('migratedAt'), operand: ViewFilterOperand.IS_EMPTY, value: '', stepFilterGroupId: GROUP, positionInStepFilterGroup: 1 },
            { id: 'has-member', type: 'TEXT', stepOutputKey: after('notifyMemberId'), operand: ViewFilterOperand.IS_NOT_EMPTY, value: '', stepFilterGroupId: GROUP, positionInStepFilterGroup: 2 },
          ],
        },
        nextStepIds: [W.send],
      },
      {
        universalIdentifier: W.send,
        name: 'Tell the owner',
        type: 'SEND_CHAT_MESSAGE',
        input: {
          workspaceMemberId: after('notifyMemberId'),
          title: 'Job hunt needs you',
          text: `${after('name')}: ${after('reason')}`,
        },
        nextStepIds: [],
      },
    ],
  },
});
