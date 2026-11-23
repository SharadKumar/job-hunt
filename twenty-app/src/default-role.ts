import { defineApplicationRole } from 'twenty-sdk/define';

import {
  APP_DISPLAY_NAME,
  DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';
import { objectGrant } from 'src/roles/utils/object-grant.util';

// The app's own role. A button runs as the member intersected with this role,
// so it needs to read (Today, the record a button acts on) and to create a
// decision. Nothing else.
export default defineApplicationRole({
  universalIdentifier: DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  label: `${APP_DISPLAY_NAME} app role`,
  description: 'Lets buttons read records and create decisions',
  recordsPermissions: {
    canReadAllRecords: true,
    canCreateAllRecords: false,
    canUpdateAllRecords: false,
    canSoftDeleteAllRecords: false,
    canDestroyAllRecords: false,
    objects: [objectGrant(OBJECT_IDS.decision, { read: true, create: true })],
  },
  canBeAssignedToUsers: false,
  canBeAssignedToApiKeys: false,
});
