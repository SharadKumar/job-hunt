import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
} from 'twenty-sdk/define';

import {
  NAVIGATION_IDS,
  OBJECT_IDS,
} from 'src/constants/universal-identifiers';

export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.documents,
  name: 'Documents',
  icon: 'IconFiles',
  color: 'gray',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: OBJECT_IDS.document,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 5,
});
