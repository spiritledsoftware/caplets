import { readFile, writeFile } from "node:fs/promises";

const cliPackage = JSON.parse(await readFile("packages/cli/package.json", "utf8"));

for (const manifestPath of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
  const manifest = await readFile(manifestPath, "utf8");
  const versionFieldPattern = /"version":\s*"[^"]+"/;

  if (!versionFieldPattern.test(manifest)) {
    throw new Error(`Could not find version field in ${manifestPath}`);
  }

  const updated = manifest.replace(versionFieldPattern, `"version": "${cliPackage.version}"`);

  await writeFile(manifestPath, updated);
}
