import { defineObject, OnDeleteAction } from 'twenty-sdk/define';

import {
  APPROVAL_STATUS_OPTIONS,
  CRITIC_VERDICT_OPTIONS,
  RESUME_VERSION_KIND_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  booleanField,
  dateTimeField,
  manyToOneField,
  rawJsonField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.resumeVersion;

// One render of a positioning's CV. Its PDF and DOCX are the only
// attachments; the harness's working files (composition, critic findings,
// provenance, audit, keyword plan, metadata) live in the workFiles JSON
// field so they never crowd the timeline.
export default defineObject({
  universalIdentifier: OBJECT_IDS.resumeVersion,
  nameSingular: 'resumeVersion',
  namePlural: 'resumeVersions',
  labelSingular: 'Resume version',
  labelPlural: 'Resume versions',
  description: 'One rendered CV of a positioning, with its approval and critic verdict',
  icon: 'IconFileCv',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    selectField({ universalIdentifier: F.kind, name: 'kind', label: 'Kind', icon: 'IconCategory', options: RESUME_VERSION_KIND_OPTIONS, defaultValue: 'BASELINE' }),
    booleanField({ universalIdentifier: F.isCurrent, name: 'isCurrent', label: 'Current', icon: 'IconStar' }),
    textField({ universalIdentifier: F.contentHash, name: 'contentHash', label: 'Content hash', icon: 'IconHash' }),
    dateTimeField({ universalIdentifier: F.renderedAt, name: 'renderedAt', label: 'Rendered', icon: 'IconCalendar' }),
    selectField({ universalIdentifier: F.approvalStatus, name: 'approvalStatus', label: 'Approval', icon: 'IconCircleCheck', options: APPROVAL_STATUS_OPTIONS, defaultValue: 'PENDING' }),
    dateTimeField({ universalIdentifier: F.approvedAt, name: 'approvedAt', label: 'Approved', icon: 'IconCalendarCheck' }),
    selectField({ universalIdentifier: F.criticVerdict, name: 'criticVerdict', label: 'Critic verdict', icon: 'IconGavel', options: CRITIC_VERDICT_OPTIONS }),
    rawJsonField({ universalIdentifier: F.workFiles, name: 'workFiles', label: 'Working files', icon: 'IconCode' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.positioning, name: 'positioning', label: 'Positioning', icon: 'IconTarget', targetObject: OBJECT_IDS.positioning, targetField: FIELD_IDS.positioning.versions, onDelete: OnDeleteAction.CASCADE }),
  ],
});
