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

export function directResourceTemplateUri(capletId: string): string {
  return `caplets://${capletId}/resources/{encodedUri}`;
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
