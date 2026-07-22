import { fileURLToPath } from "node:url";

export type SdkTestEnvironment = "browser" | "node";

const browserAliases = [
  {
    find: /^@caplets\/sdk\/project-binding$/u,
    replacement: fileURLToPath(
      new URL("./packages/sdk/src/project-binding/index.ts", import.meta.url),
    ),
  },
  {
    find: /^@caplets\/sdk$/u,
    replacement: fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
  },
];

/** Resolves public SDK entrypoints from source in tests without changing package exports. */
export function sdkSourceAliases(environment: SdkTestEnvironment) {
  return [
    ...(environment === "node"
      ? [
          {
            find: /^@caplets\/sdk\/project-binding\/node$/u,
            replacement: fileURLToPath(
              new URL("./packages/sdk/src/project-binding/node.ts", import.meta.url),
            ),
          },
        ]
      : []),
    ...browserAliases,
  ];
}
