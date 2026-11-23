import { defineRole } from 'twenty-sdk/define';

import { ROLE_IDS } from 'src/constants/universal-identifiers';
import { denyEverything } from 'src/roles/utils/deny-everything.util';

// The default for any other workspace user: nothing.
export default defineRole({
  universalIdentifier: ROLE_IDS.noAccess,
  label: 'No access',
  description: 'Default for users who are not the person',
  icon: 'IconBan',
  canUpdateAllSettings: false,
  canAccessAllTools: false,
  canBeAssignedToUsers: true,
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: false,
  permissionFlagUniversalIdentifiers: [],
  recordsPermissions: {
    canReadAllRecords: false,
    canCreateAllRecords: false,
    canUpdateAllRecords: false,
    canSoftDeleteAllRecords: false,
    canDestroyAllRecords: false,
    objects: denyEverything(),
  },
});
