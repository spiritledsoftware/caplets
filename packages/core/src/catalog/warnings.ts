import type { CatalogEntryInput, CatalogWarning } from "./types";

export function catalogWarningsForEntry(input: CatalogEntryInput): CatalogWarning[] {
  return [
    input.trustLevel === "community"
      ? warning(
          "unverified_community",
          "caution",
          "Unverified community Caplet",
          "This Caplet is indexed from a public community source and has not been reviewed by Caplets.",
        )
      : undefined,
    input.localControl
      ? warning(
          "local_control",
          "danger",
          "Local control",
          "This Caplet can operate against local project or machine state.",
        )
      : undefined,
    input.mutatesExternalState
      ? warning(
          "mutating_saas",
          "caution",
          "Can change external services",
          "This Caplet may perform mutating operations against an external service.",
        )
      : undefined,
    input.authRequired
      ? warning(
          "auth_required",
          "caution",
          "Authentication required",
          "This Caplet needs credentials or an auth flow before use.",
        )
      : undefined,
    input.setupRequired
      ? warning(
          "setup_required",
          "info",
          "Setup required",
          "This Caplet includes setup steps that should be completed before use.",
        )
      : undefined,
    input.projectBindingRequired
      ? warning(
          "project_binding_required",
          "caution",
          "Project Binding required",
          "This Caplet needs a Project Binding before it can run in the intended environment.",
        )
      : undefined,
    input.setupRequired === undefined ||
    input.authRequired === undefined ||
    input.projectBindingRequired === undefined
      ? warning(
          "readiness_unknown",
          "info",
          "Readiness unknown",
          "Some setup, auth, or runtime readiness metadata is not available for this entry.",
        )
      : undefined,
  ].filter((item): item is CatalogWarning => Boolean(item));
}

function warning(
  code: CatalogWarning["code"],
  severity: CatalogWarning["severity"],
  label: string,
  message: string,
): CatalogWarning {
  return { code, severity, label, message };
}
