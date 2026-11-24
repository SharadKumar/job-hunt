// One object entry for a role's recordsPermissions.objects. Destroy is never
// granted; soft delete (Twenty's trash, restorable) only where a caller asks.
export const objectGrant = (
  objectUniversalIdentifier: string,
  grants: { read?: boolean; create?: boolean; update?: boolean; softDelete?: boolean },
  uneditableFields?: readonly string[],
) => ({
  objectUniversalIdentifier,
  canReadAllRecords: grants.read ?? false,
  canCreateAllRecords: grants.create ?? false,
  canUpdateAllRecords: grants.update ?? false,
  canSoftDeleteAllRecords: grants.softDelete ?? false,
  canDestroyAllRecords: false,
  ...(uneditableFields && uneditableFields.length > 0
    ? { uneditableFields: [...uneditableFields] }
    : {}),
});
