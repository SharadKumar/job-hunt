import { defineObject } from 'twenty-sdk/define';

import { DOCUMENT_KIND_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  numberField,
  oneToManyField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.document;

// A durable document the person owns (profile, CV source, rules). The body
// lives in its revisions.
export default defineObject({
  universalIdentifier: OBJECT_IDS.document,
  nameSingular: 'document',
  namePlural: 'documents',
  labelSingular: 'Document',
  labelPlural: 'Documents',
  description: 'A profile, rule or source document with revision history',
  icon: 'IconFiles',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    selectField({ universalIdentifier: F.kind, name: 'kind', label: 'Kind', icon: 'IconCategory', options: DOCUMENT_KIND_OPTIONS }),
    numberField({ universalIdentifier: F.currentRevision, name: 'currentRevision', label: 'Current revision', icon: 'IconVersions' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    oneToManyField({ universalIdentifier: F.revisions, name: 'revisions', label: 'Revisions', icon: 'IconHistory', targetObject: OBJECT_IDS.documentRevision, targetField: FIELD_IDS.documentRevision.document }),
  ],
});
