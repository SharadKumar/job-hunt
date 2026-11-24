import { defineObject } from 'twenty-sdk/define';

import { FIELD_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import {
  booleanField,
  dateTimeField,
  numberField,
  textField,
} from 'src/fields/field-factories';

const F = FIELD_IDS.control;

// Display of the send switch, derived from verified decisions. Never read for
// authority: the submit path re-derives the state from the decisions.
export default defineObject({
  universalIdentifier: OBJECT_IDS.control,
  nameSingular: 'control',
  namePlural: 'controls',
  labelSingular: 'Control',
  labelPlural: 'Controls',
  description: 'Current autopilot and halt state, for display only',
  icon: 'IconToggleRight',
  labelIdentifierFieldMetadataUniversalIdentifier: F.name,
  fields: [
    textField({ universalIdentifier: F.name, name: 'name', label: 'Name', icon: 'IconAbc' }),
    // Whose own confirmation counts, so a button can warn when someone else is signed in.
    textField({ universalIdentifier: F.ownerMemberId, name: 'ownerMemberId', label: 'Owner member', icon: 'IconUser' }),
    textField({ universalIdentifier: F.ownerName, name: 'ownerName', label: 'Owner', icon: 'IconUser' }),
    booleanField({ universalIdentifier: F.autopilotEnabled, name: 'autopilotEnabled', label: 'Autopilot enabled', icon: 'IconPlane' }),
    textField({ universalIdentifier: F.enabledByDecisionId, name: 'enabledByDecisionId', label: 'Enabled by decision', icon: 'IconCheckbox' }),
    dateTimeField({ universalIdentifier: F.enabledAt, name: 'enabledAt', label: 'Enabled', icon: 'IconClock' }),
    dateTimeField({ universalIdentifier: F.expiresAt, name: 'expiresAt', label: 'Expires', icon: 'IconHourglass' }),
    numberField({ universalIdentifier: F.maxPerDay, name: 'maxPerDay', label: 'Daily cap', icon: 'IconGauge' }),
    booleanField({ universalIdentifier: F.haltOpen, name: 'haltOpen', label: 'Halt open', icon: 'IconHandStop' }),
    dateTimeField({ universalIdentifier: F.haltedAt, name: 'haltedAt', label: 'Halted', icon: 'IconClock' }),
    dateTimeField({ universalIdentifier: F.derivedAt, name: 'derivedAt', label: 'Derived', icon: 'IconRefresh' }),
  ],
});
