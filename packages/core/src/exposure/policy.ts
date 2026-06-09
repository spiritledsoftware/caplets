import type { CapletExposure } from "../config";

export type ResolvedExposure = {
  value: CapletExposure;
  direct: boolean;
  progressive: boolean;
  codeMode: boolean;
};

export function resolveExposure(
  capletExposure: CapletExposure | undefined,
  globalExposure: CapletExposure,
): ResolvedExposure {
  const value = capletExposure ?? globalExposure;
  return {
    value,
    direct: value === "direct" || value === "direct_and_code_mode",
    progressive: value === "progressive" || value === "progressive_and_code_mode",
    codeMode: value === "code_mode" || value.endsWith("_and_code_mode"),
  };
}
