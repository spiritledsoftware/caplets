import { CapletsError } from "../errors";

export function directToolName(capletId: string, operationName: string): string {
  return `${capletId}__${operationName}`;
}

export function directPromptName(capletId: string, promptName: string): string {
  return `${capletId}__${promptName}`;
}

export function nativeDirectToolName(capletId: string, operationName: string): string {
  return `caplets__${capletId}__${operationName}`;
}

export function directResourceUri(capletId: string, downstreamUri: string): string {
  return `caplets://${capletId}/resources/${encodeURIComponent(downstreamUri)}`;
}

export function directResourceTemplateUri(capletId: string, downstreamUriTemplate: string): string {
  return `caplets://${capletId}/resources/{encodedUri}?template=${encodeURIComponent(downstreamUriTemplate)}`;
}

export function decodeDirectResourceUri(uri: string): {
  capletId: string;
  downstreamUri: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", `Invalid Caplets resource URI ${uri}`, error);
  }
  if (parsed.protocol !== "caplets:" || !parsed.hostname) {
    throw new CapletsError("REQUEST_INVALID", `Invalid Caplets resource URI ${uri}`);
  }
  const prefix = "/resources/";
  if (!parsed.pathname.startsWith(prefix)) {
    throw new CapletsError("REQUEST_INVALID", `Invalid Caplets resource URI ${uri}`);
  }
  return {
    capletId: parsed.hostname,
    downstreamUri: decodeURIComponent(parsed.pathname.slice(prefix.length)),
  };
}

export function directResourceUriMatchesTemplate(uri: string, uriTemplate: string): boolean {
  return new RegExp(`^${uriTemplatePattern(uriTemplate)}$`, "u").test(uri);
}

function uriTemplatePattern(uriTemplate: string): string {
  let pattern = "";
  let offset = 0;
  for (const match of uriTemplate.matchAll(/\{([^}]+)\}/gu)) {
    pattern += escapePattern(uriTemplate.slice(offset, match.index));
    pattern += uriTemplateExpressionPattern(match[1] ?? "");
    offset = match.index + match[0].length;
  }
  return pattern + escapePattern(uriTemplate.slice(offset));
}

function uriTemplateExpressionPattern(expression: string): string {
  const operator = expression.match(/^[+#./;?&]/u)?.[0] ?? "";
  const variables = variableNames(operator ? expression.slice(1) : expression);
  if (operator === "?") return namedExpansionPattern("?", "&", variables);
  if (operator === "&") return namedExpansionPattern("&", "&", variables);
  if (operator === ";") return namedExpansionPattern(";", ";", variables);
  if (operator === "/") return optionalSequencePattern("/", "[^?#/]*", variables);
  if (operator === ".") return optionalSequencePattern(".", "[^/?#.]*", variables);
  if (operator === "#") return "(?:#[^?]*)?";
  return "[^?#]*";
}

function namedExpansionPattern(prefix: string, separator: string, variables: string[]): string {
  const alternatives = orderedNonEmptySubsets(variables).map((subset) =>
    subset.map((name) => `${escapePattern(name)}=[^&#]*`).join(escapePattern(separator)),
  );
  return alternatives.length === 0
    ? ""
    : `(?:${escapePattern(prefix)}(?:${alternatives.join("|")}))?`;
}

function optionalSequencePattern(
  prefix: string,
  valuePattern: string,
  variables: string[],
): string {
  if (variables.length === 0) return "";
  const alternatives = orderedNonEmptySubsets(variables).map((subset) =>
    subset.map(() => `${escapePattern(prefix)}${valuePattern}`).join(""),
  );
  return `(?:${alternatives.join("|")})?`;
}

function orderedNonEmptySubsets(values: string[]): string[][] {
  const subsets: string[][] = [];
  for (let mask = 1; mask < 1 << values.length; mask += 1) {
    subsets.push(values.filter((_value, index) => (mask & (1 << index)) !== 0));
  }
  return subsets;
}

function variableNames(expression: string): string[] {
  return expression
    .split(",")
    .map((value) => value.replace(/[:*].*$/u, "").trim())
    .filter(Boolean);
}

function escapePattern(value: string): string {
  return value.replace(/([.*+?^${}()|[\]\\])/gu, "\\$1");
}
