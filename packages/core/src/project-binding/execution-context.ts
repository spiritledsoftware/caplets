import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { CapletConfig } from "../config";
import { CapletsError } from "../errors";
import type { ProjectBindingSessionContext } from "./types";

export type ProjectBindingExecutionContext = Pick<
  ProjectBindingSessionContext,
  | "projectRoot"
  | "projectFingerprint"
  | "projectConfigPath"
  | "bindingId"
  | "sessionId"
  | "quarantineRecords"
>;

export function resolveProjectBoundCwd(input: {
  caplet: Pick<CapletConfig, "server" | "projectBinding">;
  configuredCwd?: string | undefined;
  context?: ProjectBindingExecutionContext | undefined;
}): string | undefined {
  if (!input.caplet.projectBinding?.required) {
    return input.configuredCwd;
  }
  const context = input.context;
  if (!context) {
    throw new CapletsError(
      "UNSUPPORTED_CAPABILITY",
      "Project Binding session context is required before this Caplet can be exposed.",
      {
        projectBinding: {
          reason: "missing_context",
          capletId: input.caplet.server,
          recoveryCommand: "Reconnect through an attach or native session with project context.",
        },
      },
    );
  }

  const root = realExistingPath(context.projectRoot, input.caplet.server, "project root");
  const requested = input.configuredCwd
    ? isAbsolute(input.configuredCwd)
      ? input.configuredCwd
      : join(root, input.configuredCwd)
    : root;
  const cwd = realExistingPath(requested, input.caplet.server, "cwd");
  if (!isPathInside(root, cwd)) {
    throw new CapletsError(
      "UNSUPPORTED_CAPABILITY",
      `Project Binding cwd escapes bound root for ${input.caplet.server}`,
      {
        projectBinding: {
          reason: "invalid_cwd",
          capletId: input.caplet.server,
          projectFingerprint: context.projectFingerprint,
        },
      },
    );
  }
  return cwd;
}

export function projectBindingConnectionKey(
  serverId: string,
  context?: ProjectBindingExecutionContext | undefined,
): string {
  return context ? `${serverId}#project:${context.projectFingerprint}` : serverId;
}

function realExistingPath(path: string, capletId: string, label: string): string {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new CapletsError(
      "CONFIG_INVALID",
      `Project Binding ${label} does not exist for ${capletId}`,
      {
        projectBinding: { reason: "invalid_cwd", capletId, path: resolved },
      },
    );
  }
  return realpathSync(resolved);
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !isAbsolute(rel));
}
