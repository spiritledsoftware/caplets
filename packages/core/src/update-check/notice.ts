import { classifyUpdateNoticeEligibility } from "./eligibility";
import { refreshUpdateMetadata } from "./refresh";
import {
  readUpdateMetadataCache,
  recordUpdateNoticeShown,
  shouldShowUpdateNotice,
  type UpdateCheckPathsOptions,
} from "./state";
import { findAvailableUpdate } from "./version";

export type MaybePrintUpdateNoticeOptions = UpdateCheckPathsOptions & {
  args: string[];
  env?: Record<string, string | undefined> | NodeJS.ProcessEnv | undefined;
  version?: string | undefined;
  fetcher?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  stderrIsTTY?: boolean | undefined;
  writeErr?: ((value: string) => void) | undefined;
  now?: number | undefined;
  refreshForLater?: boolean | undefined;
};

export async function maybePrintUpdateNotice(
  options: MaybePrintUpdateNoticeOptions,
): Promise<void> {
  const now = options.now ?? Date.now();
  const eligibility = classifyUpdateNoticeEligibility({
    args: options.args,
    env: options.env,
    stderrIsTTY: options.stderrIsTTY,
  });
  if (!options.version) return;

  const cache = readUpdateMetadataCache({ ...options, now });
  if (eligibility.eligible && cache?.status === "positive" && cache.usable) {
    const update = findAvailableUpdate(options.version, cache.metadata);
    if (update.available && shouldShowUpdateNotice(update.latestVersion, { ...options, now })) {
      try {
        const line = `Update available: caplets ${update.runningVersion} -> ${update.latestVersion}. Update with your package manager.\n`;
        if (options.writeErr) {
          options.writeErr(line);
        } else {
          process.stderr.write(line);
        }
        recordUpdateNoticeShown(update.latestVersion, { ...options, now });
      } catch {
        // Passive update notices must never affect the primary command.
      }
    }
  }

  if (
    (eligibility.eligible || eligibility.reason === "stdio") &&
    options.refreshForLater &&
    (!cache ||
      (cache.status === "positive" && !cache.fresh) ||
      (cache.status === "negative" && !cache.fresh))
  ) {
    void refreshUpdateMetadata({
      ...options,
      now,
      fetcher: options.fetcher,
      signal: options.signal,
    }).catch(() => undefined);
  }
}
