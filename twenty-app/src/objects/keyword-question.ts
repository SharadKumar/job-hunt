import { defineObject } from 'twenty-sdk/define';

import {
  KEYWORD_ANSWER_OPTIONS,
  QUESTION_STATUS_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  numberField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.keywordQuestion;

// A market term the CV source does not yet cover.
export default defineObject({
  universalIdentifier: OBJECT_IDS.keywordQuestion,
  nameSingular: 'keywordQuestion',
  namePlural: 'keywordQuestions',
  labelSingular: 'Keyword question',
  labelPlural: 'Keyword questions',
  description: 'A market keyword awaiting confirmation against the CV source',
  icon: 'IconTags',
  labelIdentifierFieldMetadataUniversalIdentifier: F.term,
  fields: [
    textField({ universalIdentifier: F.term, name: 'term', label: 'Term', icon: 'IconAbc' }),
    numberField({ universalIdentifier: F.weight, name: 'weight', label: 'Weight', icon: 'IconScale' }),
    textField({ universalIdentifier: F.cloud, name: 'cloud', label: 'Keyword cloud', icon: 'IconCloud' }),
    selectField({ universalIdentifier: F.answer, name: 'answer', label: 'Answer', icon: 'IconMessage', options: KEYWORD_ANSWER_OPTIONS }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: QUESTION_STATUS_OPTIONS, defaultValue: 'OPEN' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.positioning, name: 'positioning', label: 'Positioning', icon: 'IconTarget', targetObject: OBJECT_IDS.positioning, targetField: FIELD_IDS.positioning.keywordQuestions }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.keywordQuestions }),
  ],
});
