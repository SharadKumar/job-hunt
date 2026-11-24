import {
  defineRole,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS as STANDARD,
  SystemPermissionFlag,
} from 'twenty-sdk/define';

import {
  DECISION_CONSUME_FIELD_IDS,
  HARNESS_OWNED_FIELD_IDS,
} from 'src/constants/harness-owned-fields';
import { OBJECT_IDS, ROLE_IDS } from 'src/constants/universal-identifiers';
import { objectGrant } from 'src/roles/utils/object-grant.util';

const PERSON_OWNED_STANDARD = [
  STANDARD.person,
  STANDARD.note,
  STANDARD.noteTarget,
  STANDARD.task,
  STANDARD.taskTarget,
].map((entry) => entry.universalIdentifier);

// The person. Reads everything, confirms through buttons (create-only
// decisions), and writes their own engagements, notes, tasks and contacts.
// Every harness-owned field is uneditable. No settings; the only permission
// flag is AI, so AI chat works and can create proposals (stamped AGENT, never
// accepted as a confirmation).
export default defineRole({
  universalIdentifier: ROLE_IDS.owner,
  label: 'Owner',
  description: 'The person: reads all, confirms with decisions',
  icon: 'IconUserCheck',
  canUpdateAllSettings: false,
  canAccessAllTools: false,
  canBeAssignedToUsers: true,
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: false,
  permissionFlagUniversalIdentifiers: [SystemPermissionFlag.AI],
  recordsPermissions: {
    canReadAllRecords: true,
    canCreateAllRecords: false,
    canUpdateAllRecords: false,
    canSoftDeleteAllRecords: false,
    canDestroyAllRecords: false,
    objects: [
      ...Object.entries(HARNESS_OWNED_FIELD_IDS)
        .filter(([objectId]) => objectId !== OBJECT_IDS.decision)
        .map(([objectId, fieldIds]) =>
          // AI chat acts with this role, so it may create proposals; the
          // harness-owned proposal fields (status, outcome) stay uneditable,
          // which Twenty enforces on create too.
          objectGrant(
            objectId,
            { read: true, create: objectId === OBJECT_IDS.proposal },
            fieldIds,
          ),
        ),
      objectGrant(
        OBJECT_IDS.decision,
        { read: true, create: true },
        DECISION_CONSUME_FIELD_IDS,
      ),
      objectGrant(OBJECT_IDS.engagement, {
        read: true,
        create: true,
        update: true,
      }),
      ...PERSON_OWNED_STANDARD.map((id) =>
        objectGrant(id, { read: true, create: true, update: true }),
      ),
    ],
  },
});
