import {
  defineField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import { oneToManyField, onStandardObject } from 'src/fields/field-factories';

export default defineField(
  onStandardObject(
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
    oneToManyField({
      universalIdentifier: FIELD_IDS.company.agencyOpenings,
      name: 'agencyOpenings',
      label: 'Openings as agency',
      icon: 'IconBriefcase',
      targetObject: OBJECT_IDS.opening,
      targetField: FIELD_IDS.opening.agency,
    }),
  ),
);
