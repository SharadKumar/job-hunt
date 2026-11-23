import { defineObject } from 'twenty-sdk/define';

import { QUESTION_STATUS_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.screeningQuestion;

// A screening question the harness has no banked answer for.
export default defineObject({
  universalIdentifier: OBJECT_IDS.screeningQuestion,
  nameSingular: 'screeningQuestion',
  namePlural: 'screeningQuestions',
  labelSingular: 'Screening question',
  labelPlural: 'Screening questions',
  description: 'An open screening question from an application form',
  icon: 'IconQuestionMark',
  labelIdentifierFieldMetadataUniversalIdentifier: F.question,
  fields: [
    textField({ universalIdentifier: F.question, name: 'question', label: 'Question', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.channel, name: 'channel', label: 'Channel', icon: 'IconBroadcast' }),
    textField({ universalIdentifier: F.answer, name: 'answer', label: 'Answer', icon: 'IconMessage' }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: QUESTION_STATUS_OPTIONS, defaultValue: 'OPEN' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.screeningQuestions }),
  ],
});
