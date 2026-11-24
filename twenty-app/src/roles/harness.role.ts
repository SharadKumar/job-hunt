import {
  defineRole,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS as STANDARD,
  SystemPermissionFlag,
} from 'twenty-sdk/define';

import {
  DECISION_PERSON_FIELD_IDS,
  HARNESS_OBJECT_KEYS,
} from 'src/constants/harness-owned-fields';
import { OBJECT_IDS, ROLE_IDS } from 'src/constants/universal-identifiers';
import { objectGrant } from 'src/roles/utils/object-grant.util';

// Standard records the harness writes: employers, contacts, briefs as notes,
// follow-ups as tasks, files and timeline events.
const HARNESS_STANDARD = [
  STANDARD.company,
  STANDARD.person,
  STANDARD.note,
  STANDARD.noteTarget,
  STANDARD.task,
  STANDARD.taskTarget,
  STANDARD.attachment,
  STANDARD.timelineActivity,
].map((entry) => entry.universalIdentifier);

// The harness API key. Creates and updates what it owns, never creates a
// decision, writes only the consume fields on one, and only ever soft-deletes
// openings (to the restorable trash).
export default defineRole({
  universalIdentifier: ROLE_IDS.harness,
  label: 'Harness',
  description: 'The harness API key: writes harness-owned records',
  icon: 'IconRobot',
  canUpdateAllSettings: false,
  canAccessAllTools: false,
  canBeAssignedToUsers: false,
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: true,
  // Upload only: the harness attaches the CVs, letters and screenshots it
  // produces (and the one-time migration's archives) to their records.
  permissionFlagUniversalIdentifiers: [SystemPermissionFlag.UPLOAD_FILE],
  recordsPermissions: {
    canReadAllRecords: true,
    canCreateAllRecords: false,
    canUpdateAllRecords: false,
    canSoftDeleteAllRecords: false,
    canDestroyAllRecords: false,
    objects: [
      ...HARNESS_OBJECT_KEYS.map((key) =>
        objectGrant(OBJECT_IDS[key], {
          read: true,
          create: true,
          update: true,
          // Duplicate merges and stale-row flushes move openings to the trash,
          // where they can be restored; nothing is ever destroyed.
          softDelete: key === 'opening',
        }),
      ),
      objectGrant(
        OBJECT_IDS.decision,
        { read: true, update: true },
        DECISION_PERSON_FIELD_IDS,
      ),
      // Engagements belong to the person. The harness may create one only to
      // carry out the person's verified Start engagement decision (plan F17);
      // it never updates one afterwards.
      objectGrant(OBJECT_IDS.engagement, { read: true, create: true }),
      ...HARNESS_STANDARD.map((id) =>
        objectGrant(id, { read: true, create: true, update: true }),
      ),
    ],
  },
});
