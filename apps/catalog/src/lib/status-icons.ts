import {
  AlertCircleIcon,
  BadgeCheckIcon,
  ComputerUserIcon,
  DatabaseSyncIcon,
  Key01Icon,
  Link01Icon,
  Settings02Icon,
  Shield01Icon,
} from "./hugeicons";
import type { CatalogSearchStatusCode } from "./search-row";

type IconNode = readonly [string, Readonly<Record<string, string | number>>];
export type IconSvgObject = readonly IconNode[];

export const catalogStatusIcons: Record<CatalogSearchStatusCode, IconSvgObject> = {
  unverified_community: Shield01Icon,
  local_control: ComputerUserIcon,
  mutating_saas: DatabaseSyncIcon,
  auth_required: Key01Icon,
  setup_required: Settings02Icon,
  project_binding_required: Link01Icon,
  readiness_unknown: AlertCircleIcon,
  vault_required: Key01Icon,
};

export const catalogTrustIcons: Record<string, IconSvgObject> = {
  official: BadgeCheckIcon,
  community: Shield01Icon,
};

export { AlertCircleIcon, Copy01Icon } from "./hugeicons";
