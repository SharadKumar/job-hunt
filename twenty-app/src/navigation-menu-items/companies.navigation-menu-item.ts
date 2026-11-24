import {
  defineNavigationMenuItem,
  NavigationMenuItemType,
  STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS,
} from 'twenty-sdk/define';

import { NAVIGATION_IDS } from 'src/constants/universal-identifiers';

// Employers and agencies, inside the Job hunt section so the sidebar is one list and Home opens Today.
export default defineNavigationMenuItem({
  universalIdentifier: NAVIGATION_IDS.companies,
  name: 'Companies',
  icon: 'IconBuildingSkyscraper',
  type: NavigationMenuItemType.OBJECT,
  targetObjectUniversalIdentifier: STANDARD_OBJECT_UNIVERSAL_IDENTIFIERS.company.universalIdentifier,
  parentUniversalIdentifier: NAVIGATION_IDS.section,
  position: 8,
});
