import { readCatalogCapletFrontmatterFromMarkdown } from "@caplets/core/catalog";

const allowedProtocols = ["http", "https"];
const frontmatterPattern = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/u;
const headingPattern = /^(#{1,6})\s+(.+)$/u;
const unorderedListPattern = /^\s*[-*]\s+(.+)$/u;
const orderedListPattern = /^\s*\d+\.\s+(.+)$/u;
const fencedCodePattern = /^\s*```/u;

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
  return renderMarkdownBlocks(markdown);
}

function renderMarkdownBlocks(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { type: "ol" | "ul"; items: string[] } | undefined;
  let codeLines: string[] | undefined;

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!list) return;
    html.push(
      `<${list.type}>${list.items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${list.type}>`,
    );
    list = undefined;
  }

  function flushCode() {
    if (!codeLines) return;
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = undefined;
  }

  for (const line of lines) {
    if (codeLines) {
      if (fencedCodePattern.test(line)) {
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (fencedCodePattern.test(line)) {
      flushParagraph();
      flushList();
      codeLines = [];
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = headingPattern.exec(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = unorderedListPattern.exec(line);
    if (unordered) {
      flushParagraph();
      if (list?.type !== "ul") flushList();
      list ??= { type: "ul", items: [] };
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = orderedListPattern.exec(line);
    if (ordered) {
      flushParagraph();
      if (list?.type !== "ol") flushList();
      list ??= { type: "ol", items: [] };
      list.items.push(ordered[1]);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushCode();
  flushParagraph();
  flushList();
  return html.join("\n");
}

function renderInline(value: string): string {
  const escaped = escapeHtml(value);
  return escaped
    .replace(/`([^`]+)`/gu, (_match, code: string) => `<code>${code}</code>`)
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/gu,
      (_match, label: string, href: string, title?: string) => {
        if (!isAllowedHref(href)) return label;
        const titleAttribute = title ? ` title="${title}"` : "";
        return `<a href="${href}"${titleAttribute}>${label}</a>`;
      },
    );
}

function isAllowedHref(value: string): boolean {
  if (!value || hasControlCharacter(value)) return false;
  if (value.startsWith("#")) return true;
  if (!value.startsWith("//") && !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) return true;
  try {
    const url = new URL(value);
    return allowedProtocols.includes(url.protocol.replace(":", ""));
  } catch {
    return false;
  }
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
