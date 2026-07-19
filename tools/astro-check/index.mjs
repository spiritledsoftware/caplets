import { createRequire } from "node:module";
import path from "node:path";

import { AstroCheck } from "@astrojs/language-server";

const root = path.resolve(process.argv[2] ?? process.cwd());
const require = createRequire(import.meta.url);
const checker = new AstroCheck(root, require.resolve("typescript"));
const result = await checker.lint({ logErrors: { level: "hint" } });

console.info(
  [
    `Result (${result.fileChecked} file${result.fileChecked === 1 ? "" : "s"}):`,
    `${result.errors} error${result.errors === 1 ? "" : "s"}`,
    `${result.warnings} warning${result.warnings === 1 ? "" : "s"}`,
    `${result.hints} hint${result.hints === 1 ? "" : "s"}`,
  ].join("\n- "),
);

if (result.errors > 0) {
  process.exitCode = 1;
}
