import { defineObject } from 'twenty-sdk/define';

import {
  DECISION_RESULT_OPTIONS,
  DECISION_TYPE_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.decision;

// The person's confirmation. Created once by a button and never edited by
// the person; the harness writes only the consume fields (consumedAt,
// result, resultReason). Nobody may delete one.
export default defineObject({
  universalIdentifier: OBJECT_IDS.decision,
  nameSingular: 'decision',
  namePlural: 'decisions',
  labelSingular: 'Decision',
  labelPlural: 'Decisions',
  description: 'A confirmation the person made with a button',
  icon: 'IconCheckbox',
  isUICreatable: false,
  disabledObjectPermissionActions: [
    'canSoftDeleteObjectRecords',
    'canDestroyObjectRecords',
  ],
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    selectField({ universalIdentifier: F.decisionType, name: 'decisionType', label: 'Type', icon: 'IconCategory', options: DECISION_TYPE_OPTIONS }),
    textField({ universalIdentifier: F.statusSeen, name: 'statusSeen', label: 'Status seen', icon: 'IconEye' }),
    textField({ universalIdentifier: F.letterShaSeen, name: 'letterShaSeen', label: 'Letter hash seen', icon: 'IconHash' }),
    textField({ universalIdentifier: F.note, name: 'note', label: 'Note', icon: 'IconNotes' }),
    textField({ universalIdentifier: F.value, name: 'value', label: 'Value', icon: 'IconForms' }),
    dateTimeField({ universalIdentifier: F.expiresAt, name: 'expiresAt', label: 'Expires', icon: 'IconHourglass' }),
    dateTimeField({ universalIdentifier: F.consumedAt, name: 'consumedAt', label: 'Consumed', icon: 'IconChecks' }),
    selectField({ universalIdentifier: F.result, name: 'result', label: 'Result', icon: 'IconFlag', options: DECISION_RESULT_OPTIONS }),
    textField({ universalIdentifier: F.resultReason, name: 'resultReason', label: 'Result reason', icon: 'IconMessage' }),
    manyToOneField({ universalIdentifier: F.proposal, name: 'proposal', label: 'Proposal', icon: 'IconBulb', targetObject: OBJECT_IDS.proposal, targetField: FIELD_IDS.proposal.decisions }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.decisions }),
    manyToOneField({ universalIdentifier: F.positioning, name: 'positioning', label: 'Positioning', icon: 'IconTarget', targetObject: OBJECT_IDS.positioning, targetField: FIELD_IDS.positioning.decisions }),
  ],
});
