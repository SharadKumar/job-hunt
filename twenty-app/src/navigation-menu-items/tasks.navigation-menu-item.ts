import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { NAVIGATION_IDS } from 'src/constants/universal-identifiers';

// Follow-ups the harness schedules, inside the Job hunt section so the sidebar is one list and Home opens Today.
export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.tasks,
  name: 'Tasks',
  icon: 'IconCheckbox',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.task.universalIdentifier,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 10,
});
