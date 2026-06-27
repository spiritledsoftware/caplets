import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { readCatalogCapletFrontmatterFromMarkdown } from "@caplets/core/catalog";

const allowedProtocols = ["http", "https"];
const frontmatterPattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;

export type CatalogFrontmatterRow = {
  key: string;
  value: string;
};

export type CatalogMarkdownParts = {
  bodyMarkdown: string;
  frontmatterRows: CatalogFrontmatterRow[];
};

export function splitCatalogMarkdown(markdown: string): CatalogMarkdownParts {
  const frontmatterMatch = frontmatterPattern.exec(markdown);
  if (!frontmatterMatch) {
    return { bodyMarkdown: markdown, frontmatterRows: [] };
  }
  const frontmatter = readCatalogCapletFrontmatterFromMarkdown(frontmatterMatch[0]);
  return {
    bodyMarkdown: markdown.slice(frontmatterMatch[0].length).trimStart(),
    frontmatterRows: flattenFrontmatterRows(frontmatter),
  };
}

export async function renderCatalogMarkdown(markdown: string): Promise<string> {
  return String(
    await unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: false })
      .use(rehypeSanitize, {
        ...defaultSchema,
        attributes: {
          ...defaultSchema.attributes,
          a: [["href"], ["title"]],
          code: [["className"]],
        },
        protocols: {
          ...defaultSchema.protocols,
          href: allowedProtocols,
        },
      })
      .use(rehypeStringify)
      .process(markdown),
  );
}

function flattenFrontmatterRows(value: unknown, prefix: string[] = []): CatalogFrontmatterRow[] {
  if (Array.isArray(value)) {
    if (value.every(isScalar)) {
      return [{ key: formatKey(prefix), value: value.map(formatScalar).join(", ") }];
    }
    return value.flatMap((item, index) => flattenFrontmatterRows(item, [...prefix, `[${index}]`]));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, nested]) =>
      flattenFrontmatterRows(nested, [...prefix, key]),
    );
  }
  if (prefix.length === 0) return [];
  return [{ key: formatKey(prefix), value: formatScalar(value) }];
}

function formatKey(parts: string[]): string {
  return parts.reduce((key, part) => {
    if (!key) return part;
    return part.startsWith("[") ? `${key}${part}` : `${key}.${part}`;
  }, "");
}

function formatScalar(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function isScalar(value: unknown): boolean {
  return value === null || ["string", "number", "boolean", "undefined"].includes(typeof value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
