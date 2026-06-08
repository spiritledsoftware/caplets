import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { defaultObservedOutputShapeCacheDir } from "../src/config/paths";
import {
  backendFingerprint,
  FileObservedOutputShapeStore,
  mergeJsonShapes,
  observeOutputShape,
  observedOutputShapeKey,
  parseShapeableJsonText,
  shapeToTypeScript,
} from "../src/observed-output-shapes";

describe("Observed Output Shapes", () => {
  it("extracts structure without storing primitive values", () => {
    const observed = observeOutputShape({
      value: {
        issues: [
          {
            number: 2,
            title: "secret issue title",
            token: "ghp_secret",
            nested: { email: "person@example.com" },
          },
        ],
      },
    });

    expect(observed).toMatchObject({
      version: 1,
      source: "observed",
      sampleCount: 1,
      jsonShape: { kind: "object" },
    });
    expect(observed?.typeScript).toContain("issues?:");
    const serialized = JSON.stringify(observed);
    expect(serialized).not.toContain("secret issue title");
    expect(serialized).not.toContain("ghp_secret");
    expect(serialized).not.toContain("person@example.com");
  });

  it("ignores primitive roots and parses only JSON text objects or arrays", () => {
    expect(observeOutputShape({ value: "ok" })).toBeUndefined();
    expect(parseShapeableJsonText({ content: [{ type: "text", text: "true" }] })).toBeUndefined();
    expect(parseShapeableJsonText({ content: [{ type: "text", text: "123" }] })).toBeUndefined();
    expect(
      parseShapeableJsonText({ content: [{ type: "text", text: "# heading" }] }),
    ).toBeUndefined();
    expect(
      parseShapeableJsonText({ content: [{ type: "text", text: '{"items":[{"id":1}]}' }] }),
    ).toEqual({ items: [{ id: 1 }] });
  });

  it("merges conservatively with optional fields and bounded unions", () => {
    const first = observeOutputShape({ value: { id: "1", issue: { number: 1 } } });
    const second = observeOutputShape({
      value: { id: 2, issue: { title: "Issue" }, pull: { number: 3 } },
      existing: first,
    });

    expect(second?.typeScript).toContain("id?: number | string");
    expect(second?.typeScript).toContain("issue?:");
    expect(second?.typeScript).toContain("number?: number");
    expect(second?.typeScript).toContain("title?: string");
    expect(second?.typeScript).toContain("pull?:");
  });

  it("collapses over-wide unions and truncates wide objects", () => {
    const union = mergeJsonShapes(
      {
        kind: "union",
        variants: [{ kind: "string" }, { kind: "number" }, { kind: "boolean" }, { kind: "null" }],
      },
      { kind: "array" },
    );
    expect(union).toEqual({ kind: "unknown" });

    const wide = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => [`field_${index}`, index]),
    );
    const observed = observeOutputShape({ value: wide });
    if (!observed || observed.jsonShape.kind !== "object") throw new Error("expected object shape");
    expect(observed?.truncated).toBe(true);
    expect(Object.keys(observed.jsonShape.fields)).toHaveLength(40);
  });

  it("emits compact TypeScript and falls back to unknown when too large", () => {
    const emitted = shapeToTypeScript(
      {
        kind: "object",
        fields: {
          "not-valid-js": { optional: true, shape: { kind: "string" } },
        },
      },
      "ObservedOutput",
    );
    expect(emitted.typeScript).toBe('type ObservedOutput = { "not-valid-js"?: string; };');

    const tiny = shapeToTypeScript(
      { kind: "object", fields: { a: { optional: true, shape: { kind: "string" } } } },
      "ObservedOutput",
      10,
    );
    expect(tiny).toEqual({ typeScript: "type ObservedOutput = unknown;", truncated: true });
  });

  it("builds non-secret backend fingerprints and cache keys without input args", () => {
    const config = parseConfig({
      mcpServers: {
        github: {
          name: "GitHub",
          description: "GitHub repo ops",
          command: "github-mcp",
          args: ["stdio"],
          env: { GH_TOKEN: "secret" },
        },
      },
    });
    const caplet = config.mcpServers.github!;
    const fingerprint = backendFingerprint(caplet);
    expect(fingerprint).not.toContain("secret");

    const key = observedOutputShapeKey({
      scope: "local",
      caplet,
      toolName: "list_issues",
      projectFingerprint: "project-a",
    });
    expect(key).toMatchObject({
      capletId: "github",
      backendKind: "mcp",
      toolName: "list_issues",
      projectFingerprint: "project-a",
      resultVersion: 1,
    });
    expect(JSON.stringify(key)).not.toContain("GH_TOKEN");
  });

  it("stores, expires, and prunes filesystem cache entries", async () => {
    const dir = mkdtempSync(join(tmpdir(), "caplets-observed-shapes-"));
    const ttlMs = 1_000;
    const store = new FileObservedOutputShapeStore(dir, { ttlMs, maxEntries: 1 });
    const config = parseConfig({
      mcpServers: { alpha: { name: "Alpha", description: "Alpha tools.", command: "node" } },
    });
    const key = observedOutputShapeKey({
      scope: "local",
      caplet: config.mcpServers.alpha!,
      toolName: "read",
    });
    const shape = observeOutputShape({ value: { items: [{ id: 1 }] } })!;

    await store.write(key, shape);
    await expect(store.read(key)).resolves.toMatchObject({ sampleCount: 1 });
    await store.prune(new Date(Date.now() + ttlMs + 1));
    await expect(store.read(key)).resolves.toBeUndefined();
    await expect(store.health()).resolves.toMatchObject({ readable: true, writable: true });
  });

  it("uses platform cache conventions for result shapes", () => {
    expect(
      defaultObservedOutputShapeCacheDir({ XDG_CACHE_HOME: "/tmp/cache" }, "/home/alice", "linux"),
    ).toBe("/tmp/cache/caplets/result-shapes");
    expect(defaultObservedOutputShapeCacheDir({}, "/Users/alice", "darwin")).toBe(
      "/Users/alice/Library/Caches/caplets/result-shapes",
    );
    expect(
      defaultObservedOutputShapeCacheDir(
        { LOCALAPPDATA: "C:\\Users\\Alice\\AppData\\Local" },
        "C:\\Users\\Alice",
        "win32",
      ),
    ).toBe("C:\\Users\\Alice\\AppData\\Local\\caplets\\cache\\result-shapes");
  });
});
