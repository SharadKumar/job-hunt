import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.openings,
  name: 'Openings',
  icon: 'IconBriefcase',
  color: 'blue',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: OBJECT_IDS.opening,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 1,
});
