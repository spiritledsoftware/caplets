import { findProjectRoot, fingerprintProjectRoot } from "../cloud/project-root";
import { mutagenDoctorLine, type MutagenStatus } from "../cloud/mutagen";
import { resolveCapletsMode } from "../server/options";

export type DoctorOptions = {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  cwd?: string;
  mutagenStatus?: MutagenStatus;
};

export function formatDoctorReport(options: DoctorOptions = {}): string {
  const env = options.env ?? process.env;
  const mode = resolveCapletsMode({}, env).mode;
  const lines = [`Mode: ${mode}`];
  if (mode === "remote") {
    const server = env.CAPLETS_SERVER_URL?.trim() ?? "";
    const root = findProjectRoot(options.cwd ?? process.cwd());
    lines.push(`Server: ${server}`);
    lines.push(`Project root: ${root}`);
    lines.push(`Project fingerprint: ${fingerprintProjectRoot(root)}`);
    lines.push("Project sync: configured when local presence is active");
    lines.push(
      mutagenDoctorLine(options.mutagenStatus ?? { available: false, reason: "not checked" }),
    );
  }
  return `${lines.join("\n")}\n`;
}
