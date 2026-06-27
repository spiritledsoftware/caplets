import { describe, expect, it } from "vitest";
import {
  catalogEntryKey,
  createCatalogEntry,
  formatCatalogInstallCount,
  generateCatalogInstallCommand,
  normalizeCatalogSourceIdentity,
} from "../src/catalog";

describe("catalog model", () => {
  it("normalizes public GitHub sources and generates revision-bound install commands", () => {
    const normalized = normalizeCatalogSourceIdentity(
      "https://github.com/SpiritLedSoftware/Caplets.git",
    );

    expect(normalized).toMatchObject({
      eligible: true,
      source: {
        provider: "github",
        owner: "spiritledsoftware",
        repo: "caplets",
        repository: "spiritledsoftware/caplets",
        canonicalUrl: "https://github.com/spiritledsoftware/caplets",
      },
    });
    if (!normalized.eligible) throw new Error("expected GitHub source to be eligible");

    expect(
      generateCatalogInstallCommand({
        source: normalized.source,
        capletId: "sentry",
        resolvedRevision: "abc123def456",
      }),
    ).toEqual({
      text: "caplets install spiritledsoftware/caplets sentry",
      copyable: false,
      revisionBound: false,
      reason: "revision_install_unsupported",
    });
  });

  it("keeps official install commands in the supported shorthand shape when no revision is required", () => {
    const normalized = normalizeCatalogSourceIdentity("spiritledsoftware/caplets");
    if (!normalized.eligible) throw new Error("expected shorthand source to be eligible");

    expect(
      generateCatalogInstallCommand({
        source: normalized.source,
        capletId: "github",
      }),
    ).toEqual({
      text: "caplets install spiritledsoftware/caplets github",
      copyable: true,
      revisionBound: false,
    });
  });

  it("rejects credential, local, private, and unsupported source values without echoing them", () => {
    const cases = [
      ["https://token@github.com/spiritledsoftware/caplets", "credential_url"],
      ["../private-caplets", "local_path"],
      ["http://127.0.0.1/caplets.git", "private_host"],
      ["http://github.com/spiritledsoftware/caplets", "unsupported_source"],
      ["https://github.com/spiritledsoftware/caplets/issues/1", "unsupported_source"],
      ["https://github.com/spiritledsoftware/caplets?tab=readme", "unsupported_source"],
      ["https://example.com/spiritledsoftware/caplets", "unsupported_source"],
    ] as const;

    for (const [source, reason] of cases) {
      expect(normalizeCatalogSourceIdentity(source)).toEqual({
        eligible: false,
        reason,
        redactedSource: "[redacted]",
      });
    }
  });

  it("derives stable entry keys from source, path, and Caplet ID without including revisions", () => {
    const source = normalizeCatalogSourceIdentity("SpiritLedSoftware/Caplets");
    if (!source.eligible) throw new Error("expected source to be eligible");

    const first = catalogEntryKey({
      source: source.source,
      sourcePath: "./Caplets/Sentry/CAPLET.md",
      capletId: "Sentry",
    });
    const second = catalogEntryKey({
      source: source.source,
      sourcePath: "caplets/sentry/caplet.md",
      capletId: "sentry",
    });

    expect(first).toBe(second);
  });

  it("derives readiness, workflow, task, warnings, and low-count display from existing data", () => {
    const source = normalizeCatalogSourceIdentity("community/tools");
    if (!source.eligible) throw new Error("expected source to be eligible");

    const entry = createCatalogEntry({
      id: "deploy",
      name: "Deploy",
      description: "Deploys a project.",
      source: source.source,
      sourcePath: "caplets/deploy/CAPLET.md",
      trustLevel: "community",
      contentMarkdown: "# Deploy\n\nUse this to deploy.",
      tags: ["Deploy", "deploy", "ci"],
      useWhen: "Deploy the current project.",
      setupRequired: true,
      authRequired: true,
      projectBindingRequired: true,
      localControl: true,
      mutatesExternalState: true,
      workflow: { kind: "code_mode", label: "Code Mode" },
    });

    expect(entry.entryKey).toBe("github:community:tools:caplets%2Fdeploy%2Fcaplet.md:deploy");
    expect(entry.contentMarkdown).toBe("# Deploy\n\nUse this to deploy.");
    expect(entry.tags).toEqual(["ci", "deploy"]);
    expect(entry.setupReadiness).toBe("required");
    expect(entry.authReadiness).toBe("required");
    expect(entry.projectBindingReadiness).toBe("required");
    expect(entry.workflow).toEqual({ kind: "code_mode", label: "Code Mode" });
    expect(entry.intendedTask).toBe("Deploy the current project.");
    expect(entry.installCommand).toEqual({
      text: "caplets install community/tools deploy",
      copyable: false,
      revisionBound: false,
      reason: "revision_unavailable",
    });
    expect(entry.warnings.map((warning) => warning.code)).toEqual([
      "unverified_community",
      "local_control",
      "mutating_saas",
      "auth_required",
      "setup_required",
      "project_binding_required",
    ]);
    expect(formatCatalogInstallCount(0)).toBe("<10");
    expect(formatCatalogInstallCount(9)).toBe("<10");
    expect(formatCatalogInstallCount(1234)).toBe("1,234");
  });
});
