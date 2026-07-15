import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  acquireLegacyMigrationExclusion,
  type LegacyOfflineSourcePath,
} from "../../src/control-plane/migration/exclusion";

const root = process.argv[2];
const configRoot = process.argv[3];
const serializedSources = process.argv[4];
const phase = process.argv[5] ?? "tombstones";
if (!root || !configRoot || !serializedSources)
  throw new Error("multi-root fixture arguments required");
const sources = JSON.parse(serializedSources) as LegacyOfflineSourcePath[];
const procRoot = join(root, "multiroot-crash-proc");
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
  sourceBoundaryPath: configRoot,
  mutablePaths: [{ relativePath: "unused", kind: "file" }],
  offlineSourcePaths: sources,
  mode: "offline",
  platform: "linux",
  platformOptions: {
    linux: {
      procRootForTests: procRoot,
      proof: { kind: "offline", allReplicasStopped: true },
    },
  },
  hooks:
    phase === "activation"
      ? { afterActivationJournalDurable: crash }
      : { afterTombstonesPublished: crash },
});
if (phase === "activation") {
  await lease.completeActivation({ protectedRecoveryDurable: true });
}
