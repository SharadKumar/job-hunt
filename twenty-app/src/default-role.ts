import { defineApplicationRole } from 'twenty-sdk/define';

import {
  APP_DISPLAY_NAME,
  DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';
import { objectGrant } from 'src/roles/utils/object-grant.util';

// The app's own role. A button runs as the member intersected with this role,
// so it needs to read (Today, the record a button acts on) and to create a
// decision. The Grok tools (logic functions) run as this role too and create
// proposals: a DISCLOSURE log before full text, or a PROPOSED item for the
// person. Their code never creates a decision, and the intake refuses any
// decision this role writes anyway (its stamp is APPLICATION, not MANUAL).
// Nothing else.
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: `${APP_DISPLAY_NAME} app role`,
  description: 'Lets buttons create decisions and Grok tools create proposals',
  recordsPermissions: {
    canReadAllRecords: true,
    canCreateAllRecords: false,
    canUpdateAllRecords: false,
    canSoftDeleteAllRecords: false,
    canDestroyAllRecords: false,
    objects: [
      objectGrant(OBJECT_IDS.decision, { read: true, create: true }),
      objectGrant(OBJECT_IDS.proposal, { read: true, create: true }),
    ],
  },
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
});
