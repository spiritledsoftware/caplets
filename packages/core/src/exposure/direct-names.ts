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
  let downstreamUri: string;
  try {
    downstreamUri = decodeURIComponent(parsed.pathname.slice(prefix.length));
  } catch (error) {
    throw new CapletsError("REQUEST_INVALID", `Invalid Caplets resource URI ${uri}`, error);
  }
  return {
    capletId: parsed.hostname,
    downstreamUri,
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
  if (operator === "+") return "[^?#]*";
  if (operator === "#") return "(?:#[^?]*)?";
  return "[^/?#]*";
}

function namedExpansionPattern(prefix: string, separator: string, variables: string[]): string {
  if (variables.length === 0) return "";
  const escapedSeparator = escapePattern(separator);
  const alternatives = variables.map((name, index) => {
    const head = `${escapePattern(name)}=[^&#]*`;
    const tail = variables
      .slice(index + 1)
      .map((nextName) => `(?:${escapedSeparator}${escapePattern(nextName)}=[^&#]*)?`)
      .join("");
    return `${head}${tail}`;
  });
  return `(?:${escapePattern(prefix)}(?:${alternatives.join("|")}))?`;
}

function optionalSequencePattern(
  prefix: string,
  valuePattern: string,
  variables: string[],
): string {
  if (variables.length === 0) return "";
  return `(?:${escapePattern(prefix)}${valuePattern}){0,${variables.length}}`;
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
