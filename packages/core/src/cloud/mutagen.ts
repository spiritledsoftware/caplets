export type MutagenLicenseProfile = "mit" | "sspl" | "unknown";

export type MutagenBuildInfo = {
  version: string;
  licenseProfile: MutagenLicenseProfile;
};

export type MutagenStatus =
  | { available: true; path: string; version: string; licenseProfile: "mit" }
  | { available: false; path?: string; reason: string };

export function parseMutagenVersionOutput(output: string): MutagenBuildInfo {
  const version = output.match(/Mutagen version\s+([^\s]+)/u)?.[1] ?? "unknown";
  const normalized = output.toLocaleLowerCase();
  const licenseProfile = normalized.includes("license profile: mit")
    ? "mit"
    : normalized.includes("license profile: sspl")
      ? "sspl"
      : "unknown";
  return { version, licenseProfile };
}

export function mutagenBuildIsAllowed(info: MutagenBuildInfo): boolean {
  return info.licenseProfile === "mit";
}

export async function checkMutagenBinary(
  path: string,
  run: (path: string, args: string[]) => Promise<string>,
): Promise<MutagenStatus> {
  let output: string;
  try {
    output = await run(path, ["version"]);
  } catch (error) {
    return { available: false, path, reason: error instanceof Error ? error.message : "failed" };
  }
  const info = parseMutagenVersionOutput(output);
  if (!mutagenBuildIsAllowed(info)) {
    return { available: false, path, reason: `unsupported license profile ${info.licenseProfile}` };
  }
  return { available: true, path, version: info.version, licenseProfile: "mit" };
}

export function mutagenDoctorLine(status: MutagenStatus): string {
  if (!status.available) {
    return `Mutagen: unavailable (${status.reason})`;
  }
  return `Mutagen: available ${status.version} (${status.path})`;
}
