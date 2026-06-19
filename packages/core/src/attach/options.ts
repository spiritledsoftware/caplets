import {
  resolveRemoteSelection,
  type RemoteSelectionInput,
  type ResolvedRemoteSelection,
} from "../remote/selection";
import { resolveConfigPath, resolveProjectConfigPath } from "../config";
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "../serve/options";

export type RawAttachServeOptions = RemoteSelectionInput &
  RawServeOptions & {
    projectRoot?: string;
  };

export type AttachServeOptions = ServeOptions & {
  configPath: string;
  projectRoot: string;
  projectConfigPath: string;
  selection: ResolvedRemoteSelection;
};

export async function resolveAttachServeOptions(
  raw: RawAttachServeOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<AttachServeOptions> {
  const selection = await resolveRemoteSelection(raw, env);
  const serve = resolveServeOptions(attachLocalServeOptions(raw), env);
  const projectRoot = raw.projectRoot ?? process.cwd();
  return {
    ...serve,
    configPath: resolveConfigPath(env.CAPLETS_CONFIG?.trim() || undefined),
    projectRoot,
    projectConfigPath: env.CAPLETS_PROJECT_CONFIG?.trim() || resolveProjectConfigPath(projectRoot),
    selection,
  };
}

function attachLocalServeOptions(raw: RawAttachServeOptions): RawServeOptions {
  const {
    remoteUrl: _remoteUrl,
    workspace: _workspace,
    fetch: _fetch,
    authDir: _authDir,
    projectRoot: _projectRoot,
    ...serve
  } = raw;
  return serve;
}
