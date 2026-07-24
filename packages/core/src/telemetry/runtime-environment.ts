export type JavaScriptRuntime = "bun" | "node";

export type RuntimeDescriptor = {
  name: JavaScriptRuntime;
  version: string;
  major: number;
};

type RuntimeVersions = {
  node: string;
  bun?: string | undefined;
};

export function runtimeDescriptor(versions: RuntimeVersions = process.versions): RuntimeDescriptor {
  const name = versions.bun === undefined ? "node" : "bun";
  const version = versions.bun ?? versions.node;
  return {
    name,
    version,
    major: Number(version.split(".")[0] ?? 0),
  };
}
