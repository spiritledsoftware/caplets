import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const quickJsWasmSource = require.resolve("@jitl/quickjs-wasmfile-release-sync/wasm");
const scriptDir = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(scriptDir, "../dist");
const quickJsWasmTarget = join(distDir, "emscripten-module.wasm");

mkdirSync(distDir, { recursive: true });
copyFileSync(quickJsWasmSource, quickJsWasmTarget);
console.log(`Copied ${quickJsWasmSource} -> ${quickJsWasmTarget}`);

const typescriptEntry = require.resolve("typescript");
const typescriptLibDir = dirname(typescriptEntry);
for (const fileName of readdirSync(typescriptLibDir)) {
  if (!/^lib\..*\.d\.ts$/u.test(fileName)) {
    continue;
  }
  const source = join(typescriptLibDir, fileName);
  const target = join(distDir, fileName);
  copyFileSync(source, target);
}
console.log(`Copied TypeScript lib declarations -> ${distDir}`);
