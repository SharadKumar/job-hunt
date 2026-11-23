import { defineObject } from 'twenty-sdk/define';

import {
  APPROVAL_STATUS_OPTIONS,
  CRITIC_VERDICT_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  currencyField,
  dateTimeField,
  oneToManyField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.positioning;

// A market positioning with its baseline CV (PDF and DOCX as attachments).
export default defineObject({
  universalIdentifier: OBJECT_IDS.positioning,
  nameSingular: 'positioning',
  namePlural: 'positionings',
  labelSingular: 'Positioning',
  labelPlural: 'Positionings',
  description: 'A role type the person pursues, with its baseline CV',
  icon: 'IconTarget',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.harnessId, name: 'harnessId', label: 'Harness id', icon: 'IconId' }),
    currencyField({ universalIdentifier: F.rateMin, name: 'rateMin', label: 'Rate from', icon: 'IconCurrencyDollar' }),
    currencyField({ universalIdentifier: F.rateMax, name: 'rateMax', label: 'Rate to', icon: 'IconCurrencyDollar' }),
    selectField({ universalIdentifier: F.approvalStatus, name: 'approvalStatus', label: 'Baseline approval', icon: 'IconCircleCheck', options: APPROVAL_STATUS_OPTIONS, defaultValue: 'PENDING' }),
    dateTimeField({ universalIdentifier: F.approvedAt, name: 'approvedAt', label: 'Approved', icon: 'IconCalendarCheck' }),
    textField({ universalIdentifier: F.contentHash, name: 'contentHash', label: 'Content hash', icon: 'IconHash' }),
    selectField({ universalIdentifier: F.criticVerdict, name: 'criticVerdict', label: 'Critic verdict', icon: 'IconGavel', options: CRITIC_VERDICT_OPTIONS }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    oneToManyField({ universalIdentifier: F.openings, name: 'openings', label: 'Openings', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.positioning }),
    oneToManyField({ universalIdentifier: F.decisions, name: 'decisions', label: 'Decisions', icon: 'IconCheckbox', targetObject: OBJECT_IDS.decision, targetField: FIELD_IDS.decision.positioning }),
    oneToManyField({ universalIdentifier: F.keywordQuestions, name: 'keywordQuestions', label: 'Keyword questions', icon: 'IconTags', targetObject: OBJECT_IDS.keywordQuestion, targetField: FIELD_IDS.keywordQuestion.positioning }),
  ],
});
