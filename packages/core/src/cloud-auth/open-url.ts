import { spawn } from "node:child_process";

export type OpenUrlResult = {
  opened: boolean;
  command?: string | undefined;
};

export async function openBrowserUrl(
  url: string,
  options: { opener?: (url: string) => Promise<OpenUrlResult> | OpenUrlResult } = {},
): Promise<OpenUrlResult> {
  if (options.opener) return await options.opener(url);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return await new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.once("error", () => resolve({ opened: false, command }));
    child.once("spawn", () => {
      child.unref();
      resolve({ opened: true, command });
    });
  });
}
