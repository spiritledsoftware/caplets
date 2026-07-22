import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildProjectSyncManifest } from "./sync-filter";

export type ProjectSyncFile = {
  path: string;
  content: string;
};

export class ProjectSyncCoordinator {
  private readonly queues = new Map<string, Promise<void>>();

  async runMutating<T>(projectId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => next);
    this.queues.set(projectId, queued);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.queues.get(projectId) === queued) {
        this.queues.delete(projectId);
      }
    }
  }
}

export function projectSyncManifest(projectRoot: string): string[] {
  return buildProjectSyncManifest({ projectRoot }).files.map((file) => file.relativePath);
}

export function projectSyncFiles(projectRoot: string): ProjectSyncFile[] {
  return projectSyncManifest(projectRoot).map((path) => ({
    path,
    content: readFileSync(join(projectRoot, path), "utf8"),
  }));
}
