import { defineObject } from 'twenty-sdk/define';

import {
  CRITIC_VERDICT_OPTIONS,
  CV_MODE_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  numberField,
  rawJsonField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.application;

// The package and its submission. Written by the harness only.
export default defineObject({
  universalIdentifier: OBJECT_IDS.application,
  nameSingular: 'application',
  namePlural: 'applications',
  labelSingular: 'Application',
  labelPlural: 'Applications',
  description: 'The letter, CV and submission record for one opening',
  icon: 'IconFileText',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.letterMarkdown, name: 'letterMarkdown', label: 'Letter', icon: 'IconMail' }),
    textField({ universalIdentifier: F.letterSha, name: 'letterSha', label: 'Letter hash', icon: 'IconHash' }),
    selectField({ universalIdentifier: F.criticVerdict, name: 'criticVerdict', label: 'Critic verdict', icon: 'IconGavel', options: CRITIC_VERDICT_OPTIONS }),
    selectField({ universalIdentifier: F.cvMode, name: 'cvMode', label: 'CV mode', icon: 'IconFileCv', options: CV_MODE_OPTIONS }),
    numberField({ universalIdentifier: F.keywordCoverage, name: 'keywordCoverage', label: 'Keyword coverage', icon: 'IconPercentage' }),
    rawJsonField({ universalIdentifier: F.composition, name: 'composition', label: 'Composition', icon: 'IconBraces' }),
    dateTimeField({ universalIdentifier: F.submittedAt, name: 'submittedAt', label: 'Submitted', icon: 'IconSend' }),
    textField({ universalIdentifier: F.actor, name: 'actor', label: 'Submitted by', icon: 'IconUser' }),
    textField({ universalIdentifier: F.confirmationRef, name: 'confirmationRef', label: 'Confirmation ref', icon: 'IconReceipt' }),
    textField({ universalIdentifier: F.manualChecklist, name: 'manualChecklist', label: 'Manual checklist', icon: 'IconChecklist' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.applications }),
  ],
});
