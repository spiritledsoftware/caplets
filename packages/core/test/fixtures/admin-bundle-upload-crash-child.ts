import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  AdminBundleUploadAdmissionController,
  AdminBundleUploadCapacityError,
} from "../../src/admin-api/bundle-upload-admission";

const stagingRoot = process.argv[2];
if (!stagingRoot) throw new Error("A staging root is required.");
const stagedBytes = Number(process.argv[3] ?? "8");
if (!Number.isSafeInteger(stagedBytes) || stagedBytes <= 0) {
  throw new Error("A positive staged byte count is required.");
}
const mode = process.argv[4] ?? "crash";
if (mode !== "crash" && mode !== "live" && mode !== "contend") {
  throw new Error("A valid fixture mode is required.");
}

const controller = new AdminBundleUploadAdmissionController({
  stagingDir: stagingRoot,
  maxStagedBytes: 8,
});
const lease = await controller.acquire();
if (mode !== "contend") lease.reserveStagedBytes(stagedBytes);
const requestRoot = await lease.createRequestDirectory();
if (mode !== "contend") {
  await writeFile(join(requestRoot, "staged"), "x".repeat(stagedBytes));
}

if (mode === "live") process.on("message", () => undefined);
if (mode === "contend") {
  process.on("message", (message) => {
    if (message !== "reserve") return;
    try {
      lease.reserveStagedBytes(stagedBytes);
      process.send?.({ reservation: "acquired" });
    } catch (error) {
      process.send?.({
        reservation:
          error instanceof AdminBundleUploadCapacityError ? "capacity" : "unexpected_error",
      });
    }
  });
}

if (!process.send) throw new Error("The crash fixture requires IPC.");
process.send({ processRoot: dirname(requestRoot) }, (error) => {
  if (error) {
    console.error(error);
    process.exit(1);
  }
  if (mode === "crash") process.exit(0);
});
