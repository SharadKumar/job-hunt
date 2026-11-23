import {
  defineField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import { oneToManyField, onStandardObject } from 'src/fields/field-factories';

export default defineField(
  onStandardObject(
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
    oneToManyField({
      universalIdentifier: FIELD_IDS.person.emailDrafts,
      name: 'emailDrafts',
      label: 'Email drafts',
      icon: 'IconMail',
      targetObject: OBJECT_IDS.emailDraft,
      targetField: FIELD_IDS.emailDraft.contact,
    }),
  ),
);
