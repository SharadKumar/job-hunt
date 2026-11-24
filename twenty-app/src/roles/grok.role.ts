import { defineRole } from 'twenty-sdk/define';

import { ROLE_IDS } from 'src/constants/universal-identifiers';
import { denyEverything } from 'src/roles/utils/deny-everything.util';

// The Grok API key. No record access at all: it reaches only the app's own
// tools. Every standard and app object is denied explicitly.
export default defineRole({
  universalIdentifier: ROLE_IDS.grok,
  label: 'Grok',
  description: 'Grok API key: app tools only, no record access',
  icon: 'IconLock',
  canUpdateAllSettings: false,
  canAccessAllTools: false,
  canBeAssignedToUsers: false,
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: true,
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
