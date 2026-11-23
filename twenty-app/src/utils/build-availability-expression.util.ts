// The command menu condition for a record button: one record selected, and
// its field holds one of the given values.
export const buildAvailabilityExpression = (
  field: string,
  values: readonly string[],
): string => {
  if (values.length === 0) {
    throw new Error('A record button needs at least one value');
  }

  const clauses = values.map(
    (value) => `everyEquals(selectedRecords, "${field}", "${value}")`,
  );

  return `numberOfSelectedRecords == 1 and (${clauses.join(' or ')})`;
};
