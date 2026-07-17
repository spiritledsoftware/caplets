import { Buffer } from "node:buffer";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { parseLocalAuthorityDescriptor } from "../current-host/authority";
import { CapletsError } from "../errors";
import type { RemoteClientRole } from "../remote/server-credentials";
import type { ControlPlaneSecurityRepository } from "../control-plane/security/repository";
import type { ApprovedPendingLogin } from "../remote/server-credential-store";
import {
  deleteSecureRegularFile,
  readBoundedSecureFile,
  readBoundedSecureFileWithMetadata,
  replaceSecureFileAtomically,
  writeSecureJsonExclusive,
  type SecureFilesystemOptions,
} from "../control-plane/secure-state";

const DESCRIPTOR_FILE = "host-local-credential-authority.json";
const AUTHORITY_FILE = "authority.json";
const ENDPOINT_PATH = "/v1/pending-login/approve";
const CAPABILITY_HEADER = "x-caplets-host-capability";
const INSTANCE_HEADER = "x-caplets-host-instance";
const DESCRIPTOR_VERSION = 1;
const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CAPABILITY_TTL_MS = 2 * 60_000;
const DEFAULT_ROTATION_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 5_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export type HostLocalCredentialAuthorityDescriptor = Readonly<{
  version: 1;
  endpoint: string;
  capability: string;
  instanceNonce: string;
  logicalHostId: string;
  storeId: string;
  issuedAt: string;
  expiresAt: string;
}>;

export type HostLocalCredentialAuthority = Readonly<{
  descriptorPath: string;
  address: Readonly<{ address: "127.0.0.1"; port: number }>;
  close(): Promise<void>;
}>;

export async function startHostLocalCredentialAuthority(
  input: Readonly<{
    stateRoot: string;
    logicalHostId: string;
    storeId: string;
    authority: ControlPlaneSecurityRepository;
    filesystem?: SecureFilesystemOptions | undefined;
    capabilityTtlMs?: number | undefined;
    rotationIntervalMs?: number | undefined;
    now?: (() => Date) | undefined;
  }>,
): Promise<HostLocalCredentialAuthority> {
  const filesystem = input.filesystem ?? {};
  const descriptorPath = join(input.stateRoot, DESCRIPTOR_FILE);
  const now = input.now ?? (() => new Date());
  const capabilityTtlMs = input.capabilityTtlMs ?? DEFAULT_CAPABILITY_TTL_MS;
  const rotationIntervalMs = input.rotationIntervalMs ?? DEFAULT_ROTATION_INTERVAL_MS;
  if (!Number.isSafeInteger(capabilityTtlMs) || capabilityTtlMs <= 0) {
    throw new CapletsError("REQUEST_INVALID", "Host-local capability lifetime is invalid.");
  }
  if (!Number.isSafeInteger(rotationIntervalMs) || rotationIntervalMs <= 0) {
    throw new CapletsError("REQUEST_INVALID", "Host-local capability rotation is invalid.");
  }

  const instanceNonce = randomToken();
  let descriptor: HostLocalCredentialAuthorityDescriptor | undefined;
  let descriptorRevision: string | undefined;
  let closed = false;
  let operationTail = Promise.resolve();

  const server = createServer((request, response) => {
    operationTail = operationTail
      .then(() => handleRequest(request, response))
      .catch(() => genericResponse(response, 503, "unavailable"));
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  await listenLoopback(server);
  const address = server.address() as AddressInfo;
  if (address.address !== "127.0.0.1") {
    await closeServer(server);
    throw new CapletsError("AUTH_FAILED", "Host-local credential authority did not bind loopback.");
  }

  const publishNextDescriptor = async (): Promise<void> => {
    if (closed)
      throw new CapletsError("SERVER_UNAVAILABLE", "Host-local credential authority is closed.");
    const issuedAt = now();
    const next: HostLocalCredentialAuthorityDescriptor = Object.freeze({
      version: DESCRIPTOR_VERSION,
      endpoint: `http://127.0.0.1:${address.port}${ENDPOINT_PATH}`,
      capability: randomToken(),
      instanceNonce,
      logicalHostId: input.logicalHostId,
      storeId: input.storeId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + capabilityTtlMs).toISOString(),
    });
    const bytes = Buffer.from(`${JSON.stringify(next)}\n`, "utf8");
    if (descriptorRevision === undefined) {
      await deleteSecureRegularFile(descriptorPath, filesystem);
      const metadata = await writeSecureJsonExclusive(descriptorPath, next, filesystem);
      descriptorRevision = metadata.revision;
    } else {
      const replaced = await replaceSecureFileAtomically(
        descriptorPath,
        descriptorRevision,
        bytes,
        filesystem,
      );
      if (!replaced) {
        throw new CapletsError(
          "AUTH_FAILED",
          "Host-local credential authority changed unexpectedly.",
        );
      }
      descriptorRevision = (
        await readBoundedSecureFileWithMetadata(descriptorPath, {
          ...filesystem,
          maxBytes: MAX_REQUEST_BYTES,
        })
      ).metadata.revision;
    }
    descriptor = next;
  };

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (
      closed ||
      request.socket.remoteAddress !== "127.0.0.1" ||
      request.method !== "POST" ||
      request.url !== ENDPOINT_PATH
    ) {
      genericResponse(response, 404, "not_found");
      return;
    }
    const active = descriptor;
    if (
      !active ||
      Date.parse(active.expiresAt) <= now().getTime() ||
      !safeTokenEqual(singleHeader(request, CAPABILITY_HEADER), active.capability) ||
      !safeTokenEqual(singleHeader(request, INSTANCE_HEADER), active.instanceNonce)
    ) {
      genericResponse(response, 401, "unauthorized");
      return;
    }

    const body = await readBoundedJsonObject(request).catch(() => undefined);
    if (!body || body.version !== 1 || typeof body.operatorCode !== "string") {
      genericResponse(response, 400, "invalid_request");
      return;
    }
    const grantedRole = body.grantedRole;
    if (grantedRole !== undefined && grantedRole !== "access" && grantedRole !== "operator") {
      genericResponse(response, 400, "invalid_request");
      return;
    }

    // Consume the capability before entering the live mutation authority. Replays and stale
    // descriptors fail even when the business operation itself is rejected.
    await publishNextDescriptor();
    try {
      const approved = await input.authority.approvePendingLogin({
        operatorCode: body.operatorCode,
        ...(grantedRole ? { grantedRole } : {}),
      });
      jsonResponse(response, 200, approved);
    } catch {
      genericResponse(response, 400, "operation_failed");
    }
  };

  try {
    await publishNextDescriptor();
  } catch (error) {
    closed = true;
    await closeServer(server);
    throw error;
  }

  const rotationTimer = setInterval(() => {
    operationTail = operationTail.then(publishNextDescriptor).catch(() => undefined);
  }, rotationIntervalMs);
  rotationTimer.unref?.();

  return Object.freeze({
    descriptorPath,
    address: Object.freeze({ address: "127.0.0.1" as const, port: address.port }),
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(rotationTimer);
      await operationTail.catch(() => undefined);
      await closeServer(server);
      const current = await readDescriptor(descriptorPath, filesystem).catch(() => undefined);
      if (current?.instanceNonce === instanceNonce) {
        await deleteSecureRegularFile(descriptorPath, filesystem);
      }
    },
  });
}

export async function approvePendingLoginThroughHostLocalAuthority(
  input: Readonly<{
    stateRoot: string;
    operatorCode: string;
    grantedRole?: RemoteClientRole | undefined;
    filesystem?: SecureFilesystemOptions | undefined;
    fetch?: typeof fetch | undefined;
  }>,
): Promise<ApprovedPendingLogin> {
  const filesystem = input.filesystem ?? {};
  const fetchImpl = input.fetch ?? fetch;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const descriptor = await readAndVerifyDescriptor(input.stateRoot, filesystem);
    if (Date.parse(descriptor.expiresAt) <= Date.now()) {
      throw unavailable();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    timer.unref?.();
    try {
      const response = await fetchImpl(descriptor.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [CAPABILITY_HEADER]: descriptor.capability,
          [INSTANCE_HEADER]: descriptor.instanceNonce,
        },
        body: JSON.stringify({
          version: 1,
          operatorCode: input.operatorCode,
          ...(input.grantedRole ? { grantedRole: input.grantedRole } : {}),
        }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw unavailable();
      if (response.ok) return JSON.parse(text) as ApprovedPendingLogin;
      if (response.status !== 401) throw unavailable();
    } catch (error) {
      if (error instanceof CapletsError) throw error;
      if (attempt > 0) throw unavailable();
    } finally {
      clearTimeout(timer);
    }
  }
  throw unavailable();
}

export function hostLocalCredentialAuthorityDescriptorPath(stateRoot: string): string {
  return join(stateRoot, DESCRIPTOR_FILE);
}

async function readAndVerifyDescriptor(
  stateRoot: string,
  filesystem: SecureFilesystemOptions,
): Promise<HostLocalCredentialAuthorityDescriptor> {
  const [descriptor, authorityBytes] = await Promise.all([
    readDescriptor(join(stateRoot, DESCRIPTOR_FILE), filesystem),
    readBoundedSecureFile(join(stateRoot, AUTHORITY_FILE), { ...filesystem, maxBytes: 16 * 1024 }),
  ]).catch(() => {
    throw unavailable();
  });
  const authority = parseLocalAuthorityDescriptor(authorityBytes.toString("utf8"));
  if (
    authority.state !== "bound" ||
    authority.logicalHostId !== descriptor.logicalHostId ||
    authority.storeId !== descriptor.storeId
  ) {
    throw unavailable();
  }
  return descriptor;
}

async function readDescriptor(
  path: string,
  filesystem: SecureFilesystemOptions,
): Promise<HostLocalCredentialAuthorityDescriptor> {
  const bytes = await readBoundedSecureFile(path, { ...filesystem, maxBytes: MAX_REQUEST_BYTES });
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw unavailable();
  }
  if (!isRecord(value)) throw unavailable();
  const keys = Object.keys(value).sort().join(",");
  if (
    keys !== "capability,endpoint,expiresAt,instanceNonce,issuedAt,logicalHostId,storeId,version" ||
    value.version !== DESCRIPTOR_VERSION ||
    typeof value.endpoint !== "string" ||
    typeof value.capability !== "string" ||
    typeof value.instanceNonce !== "string" ||
    typeof value.logicalHostId !== "string" ||
    typeof value.storeId !== "string" ||
    typeof value.issuedAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !TOKEN_PATTERN.test(value.capability) ||
    !TOKEN_PATTERN.test(value.instanceNonce) ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw unavailable();
  }
  const endpoint = new URL(value.endpoint);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname !== ENDPOINT_PATH
  ) {
    throw unavailable();
  }
  return value as HostLocalCredentialAuthorityDescriptor;
}

function listenLoopback(server: Server): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject);
    resolve();
  });
  return promise;
}

function closeServer(server: Server): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  server.close(() => resolve());
  return promise;
}

async function readBoundedJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
  if (!isRecord(value)) throw new Error("request body invalid");
  return value;
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === "string" ? value : undefined;
}

function safeTokenEqual(received: string | undefined, expected: string): boolean {
  const left = createHash("sha256")
    .update(received ?? "")
    .digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right) && received?.length === expected.length;
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body, "utf8"),
    "cache-control": "no-store",
  });
  response.end(body);
}

function genericResponse(response: ServerResponse, status: number, error: string): void {
  if (response.headersSent || response.writableEnded) return;
  jsonResponse(response, status, { error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(): CapletsError {
  return new CapletsError(
    "SERVER_UNAVAILABLE",
    "Live host-local credential authority is unavailable. Start the Current Host service and retry.",
  );
}
