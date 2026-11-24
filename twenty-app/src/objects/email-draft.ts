import {
  defineObject,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { EMAIL_DRAFT_STATUS_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.emailDraft;

// A recruiter or hiring-manager email the harness drafted. The person sends it.
export default defineObject({
  universalIdentifier: OBJECT_IDS.emailDraft,
  nameSingular: 'emailDraft',
  namePlural: 'emailDrafts',
  labelSingular: 'Email draft',
  labelPlural: 'Email drafts',
  description: 'A drafted email for the person to review and send',
  icon: 'IconMail',
  labelIdentifierFieldMetadataUniversalIdentifier: F.subject,
  fields: [
    textField({ universalIdentifier: F.subject, name: 'subject', label: 'Subject', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.bodyMarkdown, name: 'bodyMarkdown', label: 'Body', icon: 'IconFileText' }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: EMAIL_DRAFT_STATUS_OPTIONS, defaultValue: 'DRAFT' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.contact, name: 'contact', label: 'Contact', icon: 'IconUser', targetObject: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier, targetField: FIELD_IDS.person.emailDrafts }),
  ],
});
