import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { FilesystemCapletSource } from "../packages/core/src/caplet-source/filesystem";
import {
  parseCapletSource,
  type ParsedCapletSourceCaplet,
} from "../packages/core/src/caplet-source/parse";
import {
  catalogAuthRequiredFromFrontmatter,
  catalogIconFromFrontmatter,
  catalogMutatesExternalStateFromFrontmatter,
  catalogProjectBindingRequiredFromFrontmatter,
  catalogSetupRequiredFromFrontmatter,
  catalogStringArrayFromFrontmatter,
  catalogStringFromFrontmatter,
  catalogUsesLocalControlFromFrontmatter,
  catalogWorkflowSummaryForBackendFamily,
  createCatalogEntry,
  normalizeCatalogSourceIdentity,
  readCatalogCapletFrontmatterFromMarkdown,
  type CatalogEntry,
  type CatalogWorkflowSummary,
} from "../packages/core/src/catalog";
import { sourceRelativeBundledPath } from "../packages/core/src/catalog/icon";

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const repoRoot = findRepoRoot(process.cwd());
  const outputPath = join(repoRoot, "apps/catalog/src/data/official-catalog.json");
  const entries = await generateOfficialCatalogEntries(repoRoot);

  if (process.argv.includes("--check")) {
    const expected = `${JSON.stringify(entries, null, 2)}\n`;
    const actual = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
    if (actual !== expected) {
      console.error("Official catalog index is out of date. Run pnpm catalog:generate.");
      console.error(`- ${relative(repoRoot, outputPath)}`);
      process.exit(1);
    }
    const assetMismatches = officialCatalogIconAssetMismatches(entries, repoRoot);
    if (assetMismatches.length) {
      console.error("Official catalog icon assets are out of date. Run pnpm catalog:generate.");
      for (const mismatch of assetMismatches) console.error(`- ${mismatch}`);
      process.exit(1);
    }
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(entries, null, 2)}\n`);
    syncOfficialCatalogIconAssets(entries, repoRoot);
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
    groupedCatalogCaplets(parsed.resolvedCaplets).map(async (caplets) => {
      const caplet = caplets[0]!;
      const file = await source.readFile(caplet.sourcePath);
      const frontmatter = readCatalogCapletFrontmatterFromMarkdown(file?.content ?? "");
      const isSuite = caplets.some((candidate) => candidate.childId);
      const id = isSuite ? caplet.parentId : caplet.id;
      return createCatalogEntry({
        id,
        name: (isSuite ? catalogStringFromFrontmatter(frontmatter.name) : undefined) ?? caplet.name,
        description:
          (isSuite ? catalogStringFromFrontmatter(frontmatter.description) : undefined) ??
          caplet.description,
        source: officialSource.source,
        sourcePath: caplet.sourcePath,
        trustLevel: "official",
        contentMarkdown: file?.content,
        icon: catalogIconFromFrontmatter(frontmatter, {
          id,
          source: officialSource.source,
          sourcePath: caplet.sourcePath,
          trustLevel: "official",
        }),
        tags:
          (isSuite ? nonEmpty(catalogStringArrayFromFrontmatter(frontmatter.tags)) : undefined) ??
          caplet.config.tags,
        setupRequired: catalogSetupRequiredFromFrontmatter(frontmatter),
        authRequired: catalogAuthRequiredFromFrontmatter(frontmatter),
        projectBindingRequired: catalogProjectBindingRequiredFromFrontmatter(frontmatter),
        workflow: workflowSummary(caplets),
        mutatesExternalState: catalogMutatesExternalStateFromFrontmatter(frontmatter),
        localControl: catalogUsesLocalControlFromFrontmatter(frontmatter),
        children: isSuite
          ? caplets.map((child) => ({
              id: child.id,
              ...(child.childId ? { childId: child.childId } : {}),
              name: child.name,
              backend: child.backend,
              workflow: workflowSummary([child]),
            }))
          : undefined,
      });
    }),
  );

  return entries.sort((left, right) => left.entryKey.localeCompare(right.entryKey));
}

function syncOfficialCatalogIconAssets(entries: CatalogEntry[], root: string): void {
  for (const entry of entries) {
    const icon = entry.icon;
    if (icon?.type !== "bundled") continue;
    const sourcePath = officialCatalogBundledIconSourcePath(root, entry);
    if (!sourcePath) continue;
    const outputPath = join(root, "apps/catalog/public", icon.url.replace(/^\//u, ""));
    mkdirSync(dirname(outputPath), { recursive: true });
    copyFileSync(sourcePath, outputPath);
  }
}

function officialCatalogIconAssetMismatches(entries: CatalogEntry[], root: string): string[] {
  const mismatches: string[] = [];
  for (const entry of entries) {
    const icon = entry.icon;
    if (icon?.type !== "bundled") continue;
    const sourcePath = officialCatalogBundledIconSourcePath(root, entry);
    const outputPath = join(root, "apps/catalog/public", icon.url.replace(/^\//u, ""));
    if (!sourcePath || !existsSync(sourcePath)) {
      mismatches.push(`missing source icon for ${entry.id}: ${entry.sourcePath}`);
      continue;
    }
    if (
      !existsSync(outputPath) ||
      readFileSync(sourcePath, "utf8") !== readFileSync(outputPath, "utf8")
    ) {
      mismatches.push(relative(root, outputPath));
    }
  }
  return mismatches;
}

function officialCatalogBundledIconSourcePath(
  root: string,
  entry: CatalogEntry,
): string | undefined {
  if (entry.icon?.type !== "bundled") return undefined;
  const sourceRelative = sourceRelativeBundledPath(entry.sourcePath, entry.icon.path);
  return sourceRelative ? join(root, "caplets", sourceRelative) : undefined;
}

function groupedCatalogCaplets(caplets: ParsedCapletSourceCaplet[]): ParsedCapletSourceCaplet[][] {
  const groups = new Map<string, ParsedCapletSourceCaplet[]>();
  for (const caplet of caplets) {
    const key = `${caplet.sourcePath}\0${caplet.parentId}`;
    const group = groups.get(key);
    if (group) {
      group.push(caplet);
    } else {
      groups.set(key, [caplet]);
    }
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.id.localeCompare(right.id)),
  );
}

function workflowSummary(caplets: ParsedCapletSourceCaplet[]): CatalogWorkflowSummary {
  if (caplets.length > 1 || caplets.some((caplet) => caplet.childId)) {
    return { kind: "set", label: "Capability suite" };
  }
  const caplet = caplets[0];
  return (
    catalogWorkflowSummaryForBackendFamily(caplet?.backend) ?? {
      kind: "set",
      label: "Caplet set",
    }
  );
}

function nonEmpty<T>(values: T[] | undefined): T[] | undefined {
  return values && values.length > 0 ? values : undefined;
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
