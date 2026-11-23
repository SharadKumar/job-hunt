import { defineObject } from 'twenty-sdk/define';

import {
  ESCALATION_PRIORITY_OPTIONS,
  ESCALATION_STATUS_OPTIONS,
} from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  manyToOneField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.escalation;

// Something that needs the person. The harness sets the priority.
export default defineObject({
  universalIdentifier: OBJECT_IDS.escalation,
  nameSingular: 'escalation',
  namePlural: 'escalations',
  labelSingular: 'Escalation',
  labelPlural: 'Escalations',
  description: 'An item the harness raised for the person',
  icon: 'IconAlertTriangle',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    textField({ universalIdentifier: F.kind, name: 'kind', label: 'Kind', icon: 'IconCategory' }),
    selectField({ universalIdentifier: F.priority, name: 'priority', label: 'Priority', icon: 'IconFlag', options: ESCALATION_PRIORITY_OPTIONS }),
    textField({ universalIdentifier: F.dedupeKey, name: 'dedupeKey', label: 'Dedupe key', icon: 'IconKey' }),
    textField({ universalIdentifier: F.reason, name: 'reason', label: 'Reason', icon: 'IconMessage' }),
    textField({ universalIdentifier: F.action, name: 'action', label: 'Action', icon: 'IconHandClick' }),
    selectField({ universalIdentifier: F.status, name: 'status', label: 'Status', icon: 'IconProgress', options: ESCALATION_STATUS_OPTIONS, defaultValue: 'OPEN' }),
    dateTimeField({ universalIdentifier: F.deliveredAt, name: 'deliveredAt', label: 'Delivered', icon: 'IconBell' }),
    dateTimeField({ universalIdentifier: F.grokDeliveredAt, name: 'grokDeliveredAt', label: 'Delivered to Grok', icon: 'IconBell' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
    manyToOneField({ universalIdentifier: F.opening, name: 'opening', label: 'Opening', icon: 'IconBriefcase', targetObject: OBJECT_IDS.opening, targetField: FIELD_IDS.opening.escalations }),
  ],
});
