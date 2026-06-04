export type MutagenBuildInfo = {
  version: string;
  licenseProfile: "mit" | "sspl" | "unknown";
};

export function parseMutagenVersionOutput(output: string): MutagenBuildInfo {
  const version = output.match(/Mutagen version\s+([^\s]+)/u)?.[1] ?? "unknown";
  const normalized = output.toLowerCase();
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
