import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireLegacyMigrationExclusion } from "../../src/control-plane/migration/exclusion";

const sourceBoundaryPath = process.argv[2];
if (!sourceBoundaryPath) throw new Error("source boundary is required");
const crashPhase = process.argv[3] ?? "relocation";

const procRoot = join(dirname(sourceBoundaryPath), "crash-proc");
const processRoot = join(procRoot, String(process.pid));
mkdirSync(processRoot, { recursive: true });
symlinkSync(`/proc/${process.pid}/fd`, join(processRoot, "fd"));
symlinkSync(`/proc/${process.pid}/cwd`, join(processRoot, "cwd"));
symlinkSync(`/proc/${process.pid}/root`, join(processRoot, "root"));
symlinkSync(`/proc/${process.pid}/exe`, join(processRoot, "exe"));

const crash = async ({ sealedSourcePath }: { sealedSourcePath: string }): Promise<never> => {
  process.stdout.write(`READY:${sealedSourcePath}\n`);
  return new Promise<never>(() => undefined);
};

const lease = await acquireLegacyMigrationExclusion({
  sourceBoundaryPath,
  mutablePaths: [
    { relativePath: "caplets", kind: "directory" },
    { relativePath: "state.json", kind: "file" },
  ],
  mode: "offline",
  platform: "linux",
  platformOptions: {
    linux: {
      procRootForTests: procRoot,
      proof: { kind: "offline", allReplicasStopped: true },
    },
  },
  hooks:
    crashPhase === "activation"
      ? { afterActivationJournalDurable: crash }
      : { afterSourceRelocated: crash },
});
await lease.completeActivation({ protectedRecoveryDurable: true });
