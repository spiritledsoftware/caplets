#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--write") {
  throw new Error("usage: sync-compose-image-version.mjs <--check|--write>");
}

const packageVersion = JSON.parse(readFileSync("packages/cli/package.json", "utf8")).version;
const composePath = "docker-compose.postgres-hardened.yml";
const compose = readFileSync(composePath, "utf8");
const imagePattern = /(ghcr\.io\/spiritledsoftware\/caplets:)[^}\s]+(?=\})/gu;
const matches = [...compose.matchAll(imagePattern)];
if (matches.length !== 3) {
  throw new Error(`${composePath} must contain exactly three default Caplets image references`);
}

const expectedImage = `ghcr.io/spiritledsoftware/caplets:${packageVersion}`;
const synchronized = compose.replace(imagePattern, expectedImage);
if (mode === "--write") {
  if (synchronized !== compose) writeFileSync(composePath, synchronized);
} else if (synchronized !== compose) {
  throw new Error(`${composePath} must default to ${expectedImage}; run pnpm version-packages`);
}
