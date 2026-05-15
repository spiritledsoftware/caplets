import { readFile, writeFile } from "node:fs/promises";

async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Could not parse JSON at ${filePath}`, { cause: error });
  }
}

const cliPackage = await readJson("packages/cli/package.json");

for (const manifestPath of [".codex-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
  const manifest = await readJson(manifestPath);

  if (typeof manifest.version !== "string") {
    throw new Error(`Could not find version field in ${manifestPath}`);
  }

  manifest.version = cliPackage.version;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
