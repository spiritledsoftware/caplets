import {
  resolveRemoteSelection,
  type RemoteSelectionInput,
  type ResolvedRemoteSelection,
} from "../remote/selection";
import { resolveServeOptions, type RawServeOptions, type ServeOptions } from "../serve/options";

export type RawAttachServeOptions = RemoteSelectionInput &
  RawServeOptions & {
    projectRoot?: string;
  };

export type AttachServeOptions = ServeOptions & {
  projectRoot: string;
  selection: ResolvedRemoteSelection;
};

export async function resolveAttachServeOptions(
  raw: RawAttachServeOptions = {},
  env: Record<string, string | undefined> = process.env,
): Promise<AttachServeOptions> {
  const selection = await resolveRemoteSelection(raw, env);
  const serve = resolveServeOptions(raw, env);
  return {
    ...serve,
    projectRoot: raw.projectRoot ?? process.cwd(),
    selection,
  };
}
