import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SECRET_REFERENCE_PATTERN = /\$env:([A-Z_][A-Z0-9_]*)|\$\{([A-Z_][A-Z0-9_]*)\}/g;
const SECRET_NAME_PATTERN = /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|CREDENTIAL|PRIVATE_KEY)/u;

describe("catalog Vault guardrails", () => {
  it("keeps checked-in catalog secret-like references on Vault syntax", () => {
    const root = join(import.meta.dirname, "../../..", "caplets");
    const violations: string[] = [];

    for (const path of markdownFiles(root)) {
      const text = readFileSync(path, "utf8");
      for (const match of text.matchAll(SECRET_REFERENCE_PATTERN)) {
        const name = match[1] ?? match[2] ?? "";
        if (SECRET_NAME_PATTERN.test(name)) {
          violations.push(`${path}: use $vault:${name} instead of ${match[0]}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});

function markdownFiles(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
  });
}
