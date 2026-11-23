import { describe, expect, it } from 'vitest';

import { buildAvailabilityExpression } from 'src/utils/build-availability-expression.util';

describe('buildAvailabilityExpression', () => {
  it('requires one selected record in one of the values', () => {
    expect(buildAvailabilityExpression('status', ['PARKED'])).toBe(
      'numberOfSelectedRecords == 1 and (everyEquals(selectedRecords, "status", "PARKED"))',
    );
  });

  it('joins several values with or', () => {
    expect(buildAvailabilityExpression('status', ['REJECTED', 'WITHDRAWN'])).toBe(
      'numberOfSelectedRecords == 1 and (everyEquals(selectedRecords, "status", "REJECTED") or everyEquals(selectedRecords, "status", "WITHDRAWN"))',
    );
  });

  it('refuses an empty value list', () => {
    expect(() => buildAvailabilityExpression('status', [])).toThrow();
  });
});
