import { defineObject } from 'twenty-sdk/define';

import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  currencyField,
  dateTimeField,
  oneToManyField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.positioning;

// A market positioning. Its rendered CVs are resume versions; the current
// one carries the approval and the PDF and DOCX.
export default defineObject({
  universalIdentifier: OBJECT_IDS.positioning,
  nameSingular: 'positioning',
  namePlural: 'positionings',
  labelSingular: 'Positioning',
  labelPlural: 'Positionings',
  description: 'A role type the person pursues; its CVs are resume versions',
  icon: 'IconTarget',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.harnessId, name: 'harnessId', label: 'Harness id', icon: 'IconId' }),
    currencyField({ universalIdentifier: F.rateMin, name: 'rateMin', label: 'Rate from', icon: 'IconCurrencyDollar' }),
    currencyField({ universalIdentifier: F.rateMax, name: 'rateMax', label: 'Rate to', icon: 'IconCurrencyDollar' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    oneToManyField({ universalIdentifier: F.openings, name: 'openings', label: 'Openings', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.positioning }),
    oneToManyField({ universalIdentifier: F.decisions, name: 'decisions', label: 'Decisions', icon: 'IconCheckbox', targetObject: OBJECT_IDS.decision, targetField: FIELD_IDS.decision.positioning }),
    oneToManyField({ universalIdentifier: F.versions, name: 'versions', label: 'CV versions', icon: 'IconFileCv', targetObject: OBJECT_IDS.resumeVersion, targetField: FIELD_IDS.resumeVersion.positioning }),
    oneToManyField({ universalIdentifier: F.keywordQuestions, name: 'keywordQuestions', label: 'Keyword questions', icon: 'IconTags', targetObject: OBJECT_IDS.keywordQuestion, targetField: FIELD_IDS.keywordQuestion.positioning }),
  ],
});
