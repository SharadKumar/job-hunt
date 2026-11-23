import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.engagements,
  name: 'Engagements',
  icon: 'IconHeartHandshake',
  color: 'grass',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: OBJECT_IDS.engagement,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 7,
});
