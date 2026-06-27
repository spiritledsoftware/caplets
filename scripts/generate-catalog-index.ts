import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FilesystemCapletSource } from "../packages/core/src/caplet-source/filesystem";
import {
  parseCapletSource,
  type ParsedCapletSourceCaplet,
} from "../packages/core/src/caplet-source/parse";
import {
  catalogWorkflowSummaryForBackendFamily,
  createCatalogEntry,
  normalizeCatalogSourceIdentity,
  type CatalogEntry,
  type CatalogWorkflowSummary,
} from "../packages/core/src/catalog";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repoRoot = findRepoRoot(process.cwd());
  const outputPath = join(repoRoot, "apps/catalog/src/data/official-catalog.json");

  if (process.argv.includes("--check")) {
    const expected = `${JSON.stringify(await generateOfficialCatalogEntries(repoRoot), null, 2)}\n`;
    const actual = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (actual !== expected) {
      console.error("Official catalog index is out of date. Run pnpm catalog:generate.");
      console.error(`- ${relative(repoRoot, outputPath)}`);
      process.exit(1);
    }
  } else {
    const entries = await generateOfficialCatalogEntries(repoRoot);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`);
    console.log(`Generated ${relative(repoRoot, outputPath)}`);
  }
}

export async function generateOfficialCatalogEntries(root: string): Promise<CatalogEntry[]> {
  const source = new FilesystemCapletSource(join(root, "caplets"));
  const parsed = await parseCapletSource(source);
  if (!parsed.ok) {
    throw new Error(
      parsed.errors
        .map((error) => [error.path, error.message].filter(Boolean).join(": "))
        .join("\n"),
    );
  }

  const officialSource = normalizeCatalogSourceIdentity("spiritledsoftware/caplets");
  if (!officialSource.eligible) {
    throw new Error("Official catalog source identity is invalid.");
  }

  const entries = await Promise.all(
    parsed.resolvedCaplets.map(async (caplet) => {
      const file = await source.readFile(caplet.sourcePath);
      return createCatalogEntry({
        id: caplet.id,
        name: caplet.name,
        description: caplet.description,
        source: officialSource.source,
        sourcePath: caplet.sourcePath,
        trustLevel: "official",
        contentMarkdown: file?.content,
        tags: caplet.config.tags,
        useWhen: caplet.config.useWhen,
        avoidWhen: caplet.config.avoidWhen,
        setupRequired: caplet.setupRequired,
        authRequired: caplet.authRequired,
        projectBindingRequired: caplet.projectBindingRequired,
        workflow: workflowSummary(caplet),
        mutatesExternalState: caplet.authRequired,
        localControl: caplet.projectBindingRequired || caplet.backend === "cli",
      });
    }),
  );

  return entries.sort((left, right) => left.entryKey.localeCompare(right.entryKey));
}

function workflowSummary(caplet: ParsedCapletSourceCaplet): CatalogWorkflowSummary {
  return (
    catalogWorkflowSummaryForBackendFamily(caplet.backend) ?? {
      kind: "set",
      label: "Caplet set",
    }
  );
}

function findRepoRoot(start: string): string {
  let current = resolve(start);
  while (!existsSync(join(current, "pnpm-workspace.yaml"))) {
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find repo root from ${start}`);
    }
    current = parent;
  }
  return current;
}
