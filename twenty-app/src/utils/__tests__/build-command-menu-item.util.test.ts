import { describe, expect, it } from 'vitest';

import { BUTTON_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import { buildCommandMenuItem } from 'src/utils/build-command-menu-item.util';

describe('buildCommandMenuItem', () => {
  it('scopes a record button to its object and statuses', () => {
    expect(buildCommandMenuItem('openingUnpark')).toEqual({
      universalIdentifier: BUTTON_IDS.openingUnpark.commandMenuItem,
      frontComponentUniversalIdentifier: BUTTON_IDS.openingUnpark.frontComponent,
      label: 'Unpark',
      isPinned: true,
      availabilityType: 'RECORD_SELECTION',
      availabilityObjectUniversalIdentifier: OBJECT_IDS.opening,
      conditionalAvailabilityExpression:
        'numberOfSelectedRecords == 1 and (everyEquals(selectedRecords, "status", "PARKED"))',
    });
  });

  it('makes switch buttons global with no condition', () => {
    const item = buildCommandMenuItem('haltSends');

    expect(item.availabilityType).toBe('GLOBAL');
    expect(item).not.toHaveProperty('conditionalAvailabilityExpression');
    expect(item).not.toHaveProperty('availabilityObjectUniversalIdentifier');
  });
});
