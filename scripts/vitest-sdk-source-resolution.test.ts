import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createClient } from "@caplets/sdk";
import { PROJECT_BINDING_SOCKET_PROTOCOL } from "@caplets/sdk/project-binding";
import { fingerprintProjectRoot } from "@caplets/sdk/project-binding/node";
import dashboardConfig from "../apps/dashboard/vitest.config";
import coreConfig from "../packages/core/vitest.config";
import { rootTestProject } from "../vitest.config";

type AliasRule = {
  find: string | RegExp;
  replacement: string;
};

function configAliases(config: unknown): AliasRule[] {
  if (typeof config !== "object" || config === null || !("resolve" in config)) {
    throw new TypeError("Vitest config must declare resolver aliases");
  }
  const resolver = config.resolve;
  if (typeof resolver !== "object" || resolver === null || !("alias" in resolver)) {
    throw new TypeError("Vitest config must declare resolver aliases");
  }
  if (!Array.isArray(resolver.alias)) {
    throw new TypeError("SDK source aliases must be an ordered alias array");
  }
  return resolver.alias.map((rule: unknown) => {
    if (
      typeof rule !== "object" ||
      rule === null ||
      !("find" in rule) ||
      !("replacement" in rule) ||
      (typeof rule.find !== "string" && !(rule.find instanceof RegExp)) ||
      typeof rule.replacement !== "string"
    ) {
      throw new TypeError("Invalid Vitest alias rule");
    }
    return { find: rule.find, replacement: rule.replacement };
  });
}

function resolveAlias(specifier: string, aliases: AliasRule[]): string | undefined {
  for (const alias of aliases) {
    if (typeof alias.find === "string") {
      if (specifier === alias.find) return alias.replacement;
      if (specifier.startsWith(`${alias.find}/`)) {
        return `${alias.replacement}${specifier.slice(alias.find.length)}`;
      }
      continue;
    }
    if (alias.find.test(specifier)) return specifier.replace(alias.find, alias.replacement);
  }
  return undefined;
}

describe("Vitest SDK source resolution", () => {
  it("runs root, core, and dashboard tests without SDK build output", () => {
    const expectedBrowserAliases = {
      "@caplets/sdk": resolve("packages/sdk/src/index.ts"),
      "@caplets/sdk/project-binding": resolve("packages/sdk/src/project-binding/index.ts"),
    };
    const expectedNodeAlias = resolve("packages/sdk/src/project-binding/node.ts");

    for (const { name, config } of [
      { name: "root", config: rootTestProject },
      { name: "core", config: coreConfig },
      { name: "dashboard", config: dashboardConfig },
    ]) {
      const aliases = configAliases(config);
      for (const [specifier, source] of Object.entries(expectedBrowserAliases)) {
        expect(resolveAlias(specifier, aliases), `${name}: ${specifier}`).toBe(source);
      }
      for (const { replacement } of aliases) {
        expect(replacement, name).not.toContain("/dist/");
      }
    }

    expect(resolveAlias("@caplets/sdk/project-binding/node", configAliases(rootTestProject))).toBe(
      expectedNodeAlias,
    );
    expect(resolveAlias("@caplets/sdk/project-binding/node", configAliases(coreConfig))).toBe(
      expectedNodeAlias,
    );
    expect(
      resolveAlias("@caplets/sdk/project-binding/node", configAliases(dashboardConfig)),
    ).toBeUndefined();

    expect(typeof createClient).toBe("function");
    expect(PROJECT_BINDING_SOCKET_PROTOCOL).toBe("caplets.project-binding.v1");
    expect(fingerprintProjectRoot(resolve("."))).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });
});
