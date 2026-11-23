import { defineObject, OnDeleteAction } from 'twenty-sdk/define';

import { DOCUMENT_KIND_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  numberField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.documentRevision;

export default defineObject({
  universalIdentifier: OBJECT_IDS.documentRevision,
  nameSingular: 'documentRevision',
  namePlural: 'documentRevisions',
  labelSingular: 'Document revision',
  labelPlural: 'Document revisions',
  description: 'One revision of a document body',
  icon: 'IconHistory',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    numberField({ universalIdentifier: F.revision, name: 'revision', label: 'Revision', icon: 'IconVersions' }),
    numberField({ universalIdentifier: F.baseRevision, name: 'baseRevision', label: 'Base revision', icon: 'IconGitBranch' }),
    selectField({ universalIdentifier: F.kind, name: 'kind', label: 'Kind', icon: 'IconCategory', options: DOCUMENT_KIND_OPTIONS }),
    textField({ universalIdentifier: F.body, name: 'body', label: 'Body', icon: 'IconFileText' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.document, name: 'document', label: 'Document', icon: 'IconFiles', targetObject: OBJECT_IDS.document, targetField: FIELD_IDS.document.revisions, onDelete: OnDeleteAction.CASCADE }),
  ],
});
