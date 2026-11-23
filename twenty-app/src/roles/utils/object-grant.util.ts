// One object entry for a role's recordsPermissions.objects. Delete is never
// granted by this app, so it is not a parameter.
export const objectGrant = (
  objectUniversalIdentifier: string,
  grants: { read?: boolean; create?: boolean; update?: boolean },
  uneditableFields?: readonly string[],
) => ({
  objectUniversalIdentifier,
  canReadAllRecords: grants.read ?? false,
  canCreateAllRecords: grants.create ?? false,
  canUpdateAllRecords: grants.update ?? false,
  canSoftDeleteAllRecords: false,
  canDestroyAllRecords: false,
  ...(uneditableFields && uneditableFields.length > 0
    ? { uneditableFields: [...uneditableFields] }
    : {}),
});
