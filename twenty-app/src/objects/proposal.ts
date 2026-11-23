import { defineObject } from 'twenty-sdk/define';

import {
  PROPOSAL_STATUS_OPTIONS,
  PROPOSAL_TYPE_OPTIONS,
  PROPOSER_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  oneToManyField,
  rawJsonField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.proposal;

// Something an agent wants to do. The person confirms or declines it.
export default defineObject({
  universalIdentifier: OBJECT_IDS.proposal,
  nameSingular: 'proposal',
  namePlural: 'proposals',
  labelSingular: 'Proposal',
  labelPlural: 'Proposals',
  description: 'An agent proposal awaiting the person',
  icon: 'IconBulb',
  labelIdentifierFieldMetadataUniversalIdentifier: F.summary,
  fields: [
    textField({ universalIdentifier: F.summary, name: 'summary', label: 'Summary', icon: 'IconAbc' }),
    selectField({ universalIdentifier: F.proposalType, name: 'proposalType', label: 'Type', icon: 'IconCategory', options: PROPOSAL_TYPE_OPTIONS }),
    selectField({ universalIdentifier: F.proposer, name: 'proposer', label: 'Proposer', icon: 'IconRobot', options: PROPOSER_OPTIONS }),
    rawJsonField({ universalIdentifier: F.payload, name: 'payload', label: 'Payload', icon: 'IconBraces' }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: PROPOSAL_STATUS_OPTIONS, defaultValue: 'PROPOSED' }),
    textField({ universalIdentifier: F.outcome, name: 'outcome', label: 'Outcome', icon: 'IconFlag' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.proposals }),
    oneToManyField({ universalIdentifier: F.decisions, name: 'decisions', label: 'Decisions', icon: 'IconCheckbox', targetObject: OBJECT_IDS.decision, targetField: FIELD_IDS.decision.proposal }),
  ],
});
