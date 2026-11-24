import { type defineCommandMenuItem } from 'twenty-sdk/define';

import { BUTTONS, type ButtonKey } from 'src/constants/buttons';
import { BUTTON_IDS, OBJECT_IDS } from 'src/constants/universal-identifiers';
import { buildAvailabilityExpression } from 'src/utils/build-availability-expression.util';

type CommandMenuItemConfig = Parameters<typeof defineCommandMenuItem>[0];

// The CLI rewrites any `<this key>:` written in source into a string of the
// expression text that follows it. The value here is already a string built
// at load time, so the key is computed to keep that rewrite away from it.
const EXPRESSION_KEY = 'conditionalAvailabilityExpression' as const;

// A pinned command for one button. Record buttons show only for a single
// selected record in an allowed state; global buttons show everywhere.
export const buildCommandMenuItem = (key: ButtonKey): CommandMenuItemConfig => {
  const spec = BUTTONS[key];
  const ids = BUTTON_IDS[key];
  const base = {
    universalIdentifier: ids.commandMenuItem,
    frontComponentUniversalIdentifier: ids.frontComponent,
    label: spec.label,
    // Not pinned: Twenty 2.60 shows every app command with the app's one icon,
    // so pinned buttons are indistinguishable. Commands stay in Cmd+K and each
    // record's menu with their names; Halt sends is also a labelled button on Today.
    isPinned: false,
  };

  if (spec.target === 'global' || !('availability' in spec)) {
    return { ...base, availabilityType: 'GLOBAL' };
  }

  return {
    ...base,
    availabilityType: 'RECORD_SELECTION',
    availabilityObjectUniversalIdentifier: OBJECT_IDS[spec.target],
    [EXPRESSION_KEY]: buildAvailabilityExpression(
      spec.availability.field,
      spec.availability.values,
    ),
  };
};
