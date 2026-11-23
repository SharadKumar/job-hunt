import { SystemPermissionFlag } from 'twenty-sdk/define';
import { STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS } from 'twenty-sdk/define';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadEntities } from 'src/__tests__/utils/load-entities';
import {
  DECISION_CONSUME_FIELD_IDS,
  HARNESS_OWNED_FIELD_IDS,
} from 'src/constants/harness-owned-fields';
import {
  DEFAULT_ROLE_UNIVERSAL_IDENTIFIER,
  FIELD_IDS,
  OBJECT_IDS,
  ROLE_IDS,
} from 'src/constants/universal-identifiers';

type ObjectGrant = {
  objectUniversalIdentifier: string;
  canReadAllRecords?: boolean;
  canCreateAllRecords?: boolean;
  canUpdateAllRecords?: boolean;
  canSoftDeleteAllRecords?: boolean;
  canDestroyAllRecords?: boolean;
  uneditableFields?: string[];
};
type Role = {
  universalIdentifier: string;
  label: string;
  canUpdateAllSettings?: boolean;
  canAccessAllTools?: boolean;
  canBeAssignedToUsers?: boolean;
  canBeAssignedToApiKeys?: boolean;
  permissionFlagUniversalIdentifiers?: string[];
  recordsPermissions?: {
    canReadAllRecords?: boolean;
    canCreateAllRecords?: boolean;
    canUpdateAllRecords?: boolean;
    canSoftDeleteAllRecords?: boolean;
    canDestroyAllRecords?: boolean;
    objects?: ObjectGrant[];
  };
};

const STANDARD_IDS = Object.values(
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS as Record<string, { universalIdentifier: string }>,
).map((entry) => entry.universalIdentifier);

let roles: Role[] = [];
const role = (id: string) => {
  const found = roles.find((r) => r.universalIdentifier === id);

  if (!found) {
    throw new Error(`role ${id} missing`);
  }

  return found;
};
const grant = (r: Role, objectId: string) =>
  r.recordsPermissions?.objects?.find((o) => o.objectUniversalIdentifier === objectId);

beforeAll(async () => {
  roles = [
    ...(await loadEntities<Role>('roles')).map((e) => e.config),
    (await import('src/default-role')).default.config as Role,
  ];
});

describe('role matrix', () => {
  it('defines Owner, Harness, Grok, No access and the app role', () => {
    expect(roles.map((r) => r.label).sort()).toEqual(
      ['Grok', 'Harness', 'Job hunt app role', 'No access', 'Owner'].sort(),
    );
  });

  it('lets no role destroy anything, and only the Harness soft-delete openings', () => {
    for (const r of roles) {
      expect(r.recordsPermissions?.canSoftDeleteAllRecords, r.label).not.toBe(true);
      expect(r.recordsPermissions?.canDestroyAllRecords, r.label).not.toBe(true);
      for (const o of r.recordsPermissions?.objects ?? []) {
        const harnessOpening = r.universalIdentifier === ROLE_IDS.harness && o.objectUniversalIdentifier === OBJECT_IDS.opening;
        expect(o.canSoftDeleteAllRecords === true, `${r.label} ${o.objectUniversalIdentifier}`).toBe(harnessOpening);
        expect(o.canDestroyAllRecords, r.label).not.toBe(true);
      }
    }
  });

  it('gives no role settings or tools, and only the Owner the AI flag', () => {
    for (const r of roles) {
      expect(r.canUpdateAllSettings, r.label).not.toBe(true);
      expect(r.canAccessAllTools, r.label).not.toBe(true);
      // Only the Owner holds a flag, and only AI (AI chat, decided in R25).
      const expected = r.label === 'Owner' ? [SystemPermissionFlag.AI] : [];
      expect(r.permissionFlagUniversalIdentifiers ?? [], r.label).toEqual(expected);
    }
  });

  it('denies Grok every standard and app object, with no grants', () => {
    const grok = role(ROLE_IDS.grok);
    const records = grok.recordsPermissions;

    expect(grok.canBeAssignedToApiKeys).toBe(true);
    expect(grok.canBeAssignedToUsers).toBe(false);
    expect(records?.canReadAllRecords).toBe(false);
    expect(records?.canCreateAllRecords).toBe(false);
    expect(records?.canUpdateAllRecords).toBe(false);
    for (const id of [...STANDARD_IDS, ...Object.values(OBJECT_IDS)]) {
      const entry = grant(grok, id);

      expect(entry, id).toBeDefined();
      expect(entry?.canReadAllRecords).toBe(false);
      expect(entry?.canCreateAllRecords).toBe(false);
      expect(entry?.canUpdateAllRecords).toBe(false);
    }
    for (const entry of records?.objects ?? []) {
      expect(entry.canReadAllRecords || entry.canCreateAllRecords || entry.canUpdateAllRecords).toBe(false);
    }
  });

  it('gives No access nothing and makes it assignable to users', () => {
    const none = role(ROLE_IDS.noAccess);

    expect(none.canBeAssignedToUsers).toBe(true);
    expect(none.recordsPermissions?.canReadAllRecords).toBe(false);
    for (const id of STANDARD_IDS) {
      expect(grant(none, id)?.canReadAllRecords, id).toBe(false);
    }
  });

  it('never lets the Harness create a decision, and only consume fields are editable', () => {
    const harness = role(ROLE_IDS.harness);
    const decision = grant(harness, OBJECT_IDS.decision);
    const editable = Object.values(FIELD_IDS.decision).filter(
      (id) => !decision?.uneditableFields?.includes(id),
    );

    expect(harness.recordsPermissions?.canCreateAllRecords).toBe(false);
    expect(decision?.canCreateAllRecords).toBe(false);
    expect(decision?.canUpdateAllRecords).toBe(true);
    expect(editable.sort()).toEqual([...DECISION_CONSUME_FIELD_IDS].sort());
  });

  it('lets the Owner create decisions but not update them, nor set consume fields', () => {
    const owner = role(ROLE_IDS.owner);
    const decision = grant(owner, OBJECT_IDS.decision);

    expect(owner.canBeAssignedToUsers).toBe(true);
    expect(owner.canBeAssignedToApiKeys).toBe(false);
    expect(owner.recordsPermissions?.canReadAllRecords).toBe(true);
    expect(owner.recordsPermissions?.canCreateAllRecords).toBe(false);
    expect(owner.recordsPermissions?.canUpdateAllRecords).toBe(false);
    expect(decision?.canCreateAllRecords).toBe(true);
    expect(decision?.canUpdateAllRecords).toBe(false);
    expect([...(decision?.uneditableFields ?? [])].sort()).toEqual([...DECISION_CONSUME_FIELD_IDS].sort());
  });

  it('makes every harness-owned field uneditable for the Owner', () => {
    const owner = role(ROLE_IDS.owner);

    for (const [objectId, fieldIds] of Object.entries(HARNESS_OWNED_FIELD_IDS)) {
      const entry = grant(owner, objectId);

      expect(entry, objectId).toBeDefined();
      expect([...(entry?.uneditableFields ?? [])].sort()).toEqual([...fieldIds].sort());
      if (objectId !== OBJECT_IDS.decision) {
        // Proposals are the one harness-owned object AI chat may create (R25).
        expect(entry?.canCreateAllRecords).toBe(objectId === OBJECT_IDS.proposal);
        expect(entry?.canUpdateAllRecords).toBe(false);
      }
    }
  });

  it('lets the Owner create only decisions, proposals, engagements, notes, tasks and people', () => {
    const owner = role(ROLE_IDS.owner);
    const S = STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS;
    const creatable = (owner.recordsPermissions?.objects ?? [])
      .filter((o) => o.canCreateAllRecords)
      .map((o) => o.objectUniversalIdentifier)
      .sort();

    expect(creatable).toEqual(
      [
        OBJECT_IDS.decision,
        OBJECT_IDS.engagement,
        OBJECT_IDS.proposal,
        S.note.universalIdentifier,
        S.noteTarget.universalIdentifier,
        S.task.universalIdentifier,
        S.taskTarget.universalIdentifier,
        S.person.universalIdentifier,
      ].sort(),
    );
  });

  it('lets the app role read and create decisions, and nothing more', () => {
    const app = role(DEFAULT_ROLE_UNIVERSAL_IDENTIFIER);
    const records = app.recordsPermissions;

    expect(records?.canReadAllRecords).toBe(true);
    expect(records?.canCreateAllRecords).toBe(false);
    expect(records?.canUpdateAllRecords).toBe(false);
    expect(records?.objects).toHaveLength(1);
    expect(grant(app, OBJECT_IDS.decision)?.canCreateAllRecords).toBe(true);
    expect(grant(app, OBJECT_IDS.decision)?.canUpdateAllRecords).toBe(false);
  });
});
