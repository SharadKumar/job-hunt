import {
  defineField,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { COMPANY_KIND_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS } from 'src/constants/universal-identifiers';
import { onStandardObject, selectField } from 'src/fields/field-factories';

// Whether a company is the end client, an agency or a job platform.
export default defineField(
  onStandardObject(
    STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
    selectField({
      universalIdentifier: FIELD_IDS.company.kind,
      name: 'kind',
      label: 'Kind',
      icon: 'IconCategory',
      options: COMPANY_KIND_OPTIONS,
    }),
  ),
);
