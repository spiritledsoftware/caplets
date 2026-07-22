import { CapletsError } from "../errors";

const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export async function readLimitedJsonObject(
  request: Request,
  label: string,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer.");
  }

  validateDeclaredLength(request, label, maxBytes);

  let bytes: Uint8Array;
  try {
    bytes = request.body
      ? await readLimitedStream(request.body, label, maxBytes)
      : await readMaterializedBody(request, label, maxBytes);
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw malformedJsonError(label);
  }

  let parsed: unknown;
  try {
    const text = fatalUtf8Decoder.decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    throw malformedJsonError(label);
  }

  if (!isRecord(parsed)) {
    throw new CapletsError("REQUEST_INVALID", `${label} JSON must be an object.`);
  }
  return parsed;
}

const COMMAND_ENVELOPE_PREFIX_MAX_BYTES = 256;
const COMMAND_KEY_BYTES = new TextEncoder().encode('"command"');
const ARGUMENTS_KEY_BYTES = new TextEncoder().encode('"arguments"');

type CommandPrefixClassification =
  | { kind: "incomplete" }
  | { kind: "ordinary" }
  | { kind: "elevated"; command: string };

// Elevated requests must use the canonical {"command":...,"arguments":{...}} member order
// within this bounded prefix. Non-canonical envelopes retain the ordinary ceiling.
export async function readCommandLimitedJsonObject(
  request: Request,
  label: string,
  ordinaryMaxBytes: number,
  elevatedMaxBytes: number,
  elevatedCommands: Readonly<Record<string, true>>,
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(ordinaryMaxBytes) ||
    ordinaryMaxBytes < 0 ||
    !Number.isSafeInteger(elevatedMaxBytes) ||
    elevatedMaxBytes < ordinaryMaxBytes
  ) {
    throw new RangeError("Request body limits must be non-negative safe integers.");
  }

  const declaredBytes = validateDeclaredLength(request, label, elevatedMaxBytes);
  let bytes: Uint8Array;
  let framedCommand: string | undefined;
  try {
    if (request.body) {
      const streamed = await readCommandLimitedStream(
        request.body,
        label,
        ordinaryMaxBytes,
        elevatedMaxBytes,
        elevatedCommands,
        declaredBytes,
      );
      bytes = streamed.bytes;
      framedCommand = streamed.framedCommand;
    } else {
      bytes = await readMaterializedBody(request, label, ordinaryMaxBytes);
    }
  } catch (error) {
    if (error instanceof CapletsError) throw error;
    throw malformedJsonError(label);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(fatalUtf8Decoder.decode(bytes));
  } catch {
    throw malformedJsonError(label);
  }
  if (!isRecord(parsed)) {
    throw new CapletsError("REQUEST_INVALID", `${label} JSON must be an object.`);
  }
  if (framedCommand !== undefined && parsed.command !== framedCommand) {
    throw new CapletsError("REQUEST_INVALID", `${label} command framing is invalid.`);
  }
  return parsed;
}

async function readCommandLimitedStream(
  body: ReadableStream<Uint8Array>,
  label: string,
  ordinaryMaxBytes: number,
  elevatedMaxBytes: number,
  elevatedCommands: Readonly<Record<string, true>>,
  declaredBytes: number | undefined,
): Promise<{ bytes: Uint8Array; framedCommand: string | undefined }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const prefix = new Uint8Array(COMMAND_ENVELOPE_PREFIX_MAX_BYTES);
  let prefixBytes = 0;
  let totalBytes = 0;
  let classification: CommandPrefixClassification = { kind: "incomplete" };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (classification.kind === "incomplete") {
        const copiedBytes = Math.min(value.byteLength, prefix.byteLength - prefixBytes);
        prefix.set(value.subarray(0, copiedBytes), prefixBytes);
        prefixBytes += copiedBytes;
        classification = classifyCommandEnvelopePrefix(
          prefix.subarray(0, prefixBytes),
          elevatedCommands,
        );
        if (classification.kind === "incomplete" && prefixBytes === prefix.byteLength) {
          classification = { kind: "ordinary" };
        }
      }
      const maxBytes = classification.kind === "elevated" ? elevatedMaxBytes : ordinaryMaxBytes;
      if (
        (classification.kind !== "incomplete" &&
          declaredBytes !== undefined &&
          declaredBytes > maxBytes) ||
        value.byteLength > maxBytes - totalBytes
      ) {
        await cancelReader(reader);
        throw bodyTooLargeError(label);
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return {
    bytes: concatChunks(chunks, totalBytes),
    framedCommand: classification.kind === "elevated" ? classification.command : undefined,
  };
}

function classifyCommandEnvelopePrefix(
  bytes: Uint8Array,
  elevatedCommands: Readonly<Record<string, true>>,
): CommandPrefixClassification {
  let offset = skipJsonWhitespace(bytes, 0);
  if (offset === bytes.length) return { kind: "incomplete" };
  if (bytes[offset] !== 0x7b) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, offset + 1);
  const commandKey = consumeExactBytes(bytes, offset, COMMAND_KEY_BYTES);
  if (commandKey === undefined) return { kind: "incomplete" };
  if (commandKey < 0) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, commandKey);
  if (offset === bytes.length) return { kind: "incomplete" };
  if (bytes[offset] !== 0x3a) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, offset + 1);
  if (offset === bytes.length) return { kind: "incomplete" };
  if (bytes[offset] !== 0x22) return { kind: "ordinary" };
  const commandStart = offset + 1;
  offset = commandStart;
  while (offset < bytes.length && bytes[offset] !== 0x22) {
    const byte = bytes[offset]!;
    if (byte === 0x5c || byte < 0x20 || byte > 0x7e) return { kind: "ordinary" };
    offset += 1;
  }
  if (offset === bytes.length) return { kind: "incomplete" };
  const command = String.fromCharCode(...bytes.subarray(commandStart, offset));
  if (elevatedCommands[command] !== true) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, offset + 1);
  if (offset === bytes.length) return { kind: "incomplete" };
  if (bytes[offset] !== 0x2c) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, offset + 1);
  const argumentsKey = consumeExactBytes(bytes, offset, ARGUMENTS_KEY_BYTES);
  if (argumentsKey === undefined) return { kind: "incomplete" };
  if (argumentsKey < 0) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, argumentsKey);
  if (offset === bytes.length) return { kind: "incomplete" };
  if (bytes[offset] !== 0x3a) return { kind: "ordinary" };
  offset = skipJsonWhitespace(bytes, offset + 1);
  if (offset === bytes.length) return { kind: "incomplete" };
  return bytes[offset] === 0x7b ? { kind: "elevated", command } : { kind: "ordinary" };
}

function consumeExactBytes(
  bytes: Uint8Array,
  offset: number,
  expected: Uint8Array,
): number | undefined {
  const available = Math.min(bytes.length - offset, expected.length);
  for (let index = 0; index < available; index += 1) {
    if (bytes[offset + index] !== expected[index]) return -1;
  }
  return available < expected.length ? undefined : offset + expected.length;
}

function skipJsonWhitespace(bytes: Uint8Array, start: number): number {
  let offset = start;
  while (offset < bytes.length) {
    const byte = bytes[offset];
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) break;
    offset += 1;
  }
  return offset;
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The size error is authoritative even when the source rejects cancellation.
  }
}

function validateDeclaredLength(
  request: Request,
  label: string,
  maxBytes: number,
): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  if (!/^\d+$/u.test(header)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${label} content length must be a non-negative integer.`,
    );
  }
  const declaredBytes = Number(header);
  if (!Number.isSafeInteger(declaredBytes)) {
    throw new CapletsError(
      "REQUEST_INVALID",
      `${label} content length must be a non-negative integer.`,
    );
  }
  if (declaredBytes > maxBytes) throw bodyTooLargeError(label);
  return declaredBytes;
}

async function readLimitedStream(
  body: ReadableStream<Uint8Array>,
  label: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > maxBytes - totalBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error is authoritative even when the source rejects cancellation.
        }
        throw bodyTooLargeError(label);
      }
      chunks.push(value);
      totalBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return concatChunks(chunks, totalBytes);
}

async function readMaterializedBody(
  request: Request,
  label: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maxBytes) throw bodyTooLargeError(label);
  return bytes;
}

function concatChunks(chunks: Uint8Array[], totalBytes: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function malformedJsonError(label: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", `${label} body must be valid JSON.`);
}

function bodyTooLargeError(label: string): CapletsError {
  return new CapletsError("REQUEST_INVALID", `${label} body is too large.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
