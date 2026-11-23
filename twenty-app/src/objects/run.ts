import { defineObject } from 'twenty-sdk/define';

import { RUN_KIND_OPTIONS } from 'src/constants/select-options';
import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  dateTimeField,
  numberField,
  selectField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.run;

// One harness run. Replaces the daily journal.
export default defineObject({
  universalIdentifier: OBJECT_IDS.run,
  nameSingular: 'run',
  namePlural: 'runs',
  labelSingular: 'Run',
  labelPlural: 'Runs',
  description: 'One harness run with what it sent and raised',
  icon: 'IconPlayerPlay',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    selectField({ universalIdentifier: F.kind, name: 'kind', label: 'Kind', icon: 'IconCategory', options: RUN_KIND_OPTIONS }),
    dateTimeField({ universalIdentifier: F.startedAt, name: 'startedAt', label: 'Started', icon: 'IconClock' }),
    dateTimeField({ universalIdentifier: F.finishedAt, name: 'finishedAt', label: 'Finished', icon: 'IconClockCheck' }),
    numberField({ universalIdentifier: F.exitCode, name: 'exitCode', label: 'Exit code', icon: 'IconTerminal' }),
    numberField({ universalIdentifier: F.sentCount, name: 'sentCount', label: 'Sent', icon: 'IconSend' }),
    numberField({ universalIdentifier: F.escalationCount, name: 'escalationCount', label: 'Escalations', icon: 'IconAlertTriangle' }),
    textField({ universalIdentifier: F.summary, name: 'summary', label: 'Summary', icon: 'IconFileText' }),
    textField({ universalIdentifier: F.lettersSentUnattended, name: 'lettersSentUnattended', label: 'Letters sent unattended', icon: 'IconMail' }),
    dateTimeField({ universalIdentifier: F.migratedAt, name: 'migratedAt', label: 'Migrated', icon: 'IconTransfer' }),
  ],
});
