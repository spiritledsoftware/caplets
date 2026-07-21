import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fingerprintProjectRoot } from "../src/project-binding/node";

type MockMarker =
  | { kind: "directory" }
  | { kind: "file"; contents: string }
  | { kind: "read-error" }
  | { kind: "stat-error" };

const mockFileSystem = vi.hoisted(() => ({
  markers: new Map<string, MockMarker>(),
}));

vi.mock("node:fs", () => ({
  existsSync: (path: unknown) => mockFileSystem.markers.has(String(path)),
  readFileSync: (path: unknown) => {
    const marker = mockFileSystem.markers.get(String(path));
    if (marker?.kind !== "file") throw new Error("unreadable fixture");
    return new TextEncoder().encode(marker.contents);
  },
  statSync: (path: unknown) => {
    const marker = mockFileSystem.markers.get(String(path));
    if (!marker || marker.kind === "stat-error") throw new Error("unreadable fixture");
    return { isDirectory: () => marker.kind === "directory" };
  },
}));

const WINDOWS = process.platform === "win32";
const fixtureRoot = (name: string) =>
  WINDOWS ? `C:\\caplets-sdk-fixture\\${name}` : `/caplets-sdk-fixture/${name}`;

function setMarker(root: string, name: string, marker: MockMarker): void {
  mockFileSystem.markers.set(join(root, name), marker);
}

describe("fingerprintProjectRoot", () => {
  beforeEach(() => {
    mockFileSystem.markers.clear();
  });

  it("hashes every marker in the fixed order", () => {
    const root = fixtureRoot("project");
    setMarker(root, "pnpm-workspace.yaml", {
      kind: "file",
      contents: "packages:\n  - packages/*\n",
    });
    setMarker(root, "package.json", { kind: "file", contents: '{"name":"demo"}\n' });
    setMarker(root, ".git", {
      kind: "file",
      contents: "gitdir: ../.git/worktrees/project\n",
    });
    setMarker(root, ".caplets", { kind: "directory" });

    expect(fingerprintProjectRoot(root)).toBe(
      WINDOWS
        ? "sha256:f74a35c8608580a793527c746d6ce8c3542dc8a4ee1758939ec2fc49f2f2d0f9"
        : "sha256:cdb8d08af6af26a08407f19d6818d2c711e33f3f7b2baae02c66f24f438a8244",
    );
  });

  it("hashes file bytes so a marker file change has a known new digest", () => {
    const root = fixtureRoot("file-change");
    setMarker(root, "package.json", { kind: "file", contents: '{"name":"demo"}\n' });

    expect(fingerprintProjectRoot(root)).toBe(
      WINDOWS
        ? "sha256:a35fdd599a58b3dc5cb6643929b12fd56eae30c4acd2341445365e6bea7b75a4"
        : "sha256:0a884755c7f09e98ac548ec1e36f650205e341211871af35006a81d3a8639974",
    );

    setMarker(root, "package.json", { kind: "file", contents: '{"name":"changed"}\n' });

    expect(fingerprintProjectRoot(root)).toBe(
      WINDOWS
        ? "sha256:67f0f4f610e1164917bfdc62aa80572fe26ad86c7f417eadaaac1de5abf27769"
        : "sha256:3cb4f02a4b3324f64e345c4be1914398931e8e68e8bdc3e726b122b89aa13a04",
    );
  });

  it("hashes the literal directory sentinel for a directory marker", () => {
    const root = fixtureRoot("directory");
    setMarker(root, ".git", { kind: "directory" });

    expect(fingerprintProjectRoot(root)).toBe(
      WINDOWS
        ? "sha256:180fb6e89d0e13c3b6a5dd18717c34c71dfef78e35a888cf55d2f1f49b82a615"
        : "sha256:37691116a3e340e23799def3645ef5a52ed1c11b9fce12c4465e31ecac48a784",
    );
  });

  it("normalizes the root before hashing it", () => {
    const root = fixtureRoot("normalized-project");
    const unnormalized = `${root}${sep}child${sep}..${sep}.`;

    expect(fingerprintProjectRoot(unnormalized)).toBe(
      WINDOWS
        ? "sha256:e5095fa6eb323f0b1ca68329b2ec3d819b096b24f3872a6be38154bf9c24979e"
        : "sha256:c7175fb2747ae8ec1335facfc4780bf4383164e95fcdbc1813aeabd460577fce",
    );
  });

  it("hashes unreadable when stat or file reads fail", () => {
    const root = fixtureRoot("unreadable");
    setMarker(root, ".caplets", { kind: "stat-error" });
    setMarker(root, "package.json", { kind: "read-error" });

    expect(fingerprintProjectRoot(root)).toBe(
      WINDOWS
        ? "sha256:ab536d89fdce12600cd8cacd9561ca50f1d7fdfca6d4ad03a21a3b9e27dc2287"
        : "sha256:f70a4b66473e208d2063dba37984985f4545a875a3d51e50ac0860664d74ba76",
    );
  });
});
