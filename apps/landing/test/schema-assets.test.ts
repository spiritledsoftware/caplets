import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = join(import.meta.dirname, "../../..");

describe("schema assets", () => {
  it.each([
    ["config.schema.json", "schemas/caplets-config.schema.json"],
    ["caplet-frontmatter.schema.json", "schemas/caplet.schema.json"],
  ])("publishes %s from the generated schema source", (assetName, schemaPath) => {
    const publicAsset = readFileSync(join(repoRoot, "apps/landing/public", assetName), "utf8");
    const generatedSchema = readFileSync(join(repoRoot, schemaPath), "utf8");

    expect(publicAsset).toBe(generatedSchema);
  });
});
