import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { NAVIGATION_IDS } from 'src/constants/universal-identifiers';

// Recruiters and hiring managers, inside the Job hunt section so the sidebar is one list and Home opens Today.
export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.people,
  name: 'People',
  icon: 'IconUser',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.person.universalIdentifier,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 9,
});
