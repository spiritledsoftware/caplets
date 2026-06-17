// @ts-expect-error package has no bundled types in this repo
import structuredClone from "@ungap/structured-clone";
import { Blob, File, FormData } from "formdata-node";
import { Headers } from "headers-polyfill";

declare function __caplets_log(level: string, message: string): void;

const DISABLED_FETCH_MESSAGE = "Direct fetch is not available in Code Mode; use a Caplet instead.";
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const base64Lookup = new Map(BASE64_ALPHABET.split("").map((char, index) => [char, index]));

type BufferEncoding = "utf8" | "utf-8" | "base64" | "base64url" | "hex";
type BodyValue = Blob | FormData | string | ArrayBuffer | ArrayBufferView | null | undefined;
type HeadersValue = Headers | Record<string, string> | Array<[string, string]>;
type AbortListener = (event: { type: "abort"; target: AbortSignalShim }) => void;
type UrlParamInit = string | Array<[string, string]> | Record<string, string> | URLSearchParamsShim;

function utf8Encode(input: string): Uint8Array {
  const encoded = encodeURIComponent(input);
  const bytes: number[] = [];
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] === "%") {
      bytes.push(Number.parseInt(encoded.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(encoded.charCodeAt(index));
  }
  return Uint8Array.from(bytes);
}

function utf8Decode(input: Uint8Array): string {
  let encoded = "";
  for (const value of input) {
    encoded += value < 128 ? String.fromCharCode(value) : `%${value.toString(16).padStart(2, "0")}`;
  }
  return decodeURIComponent(encoded);
}

class TextEncoderShim {
  readonly encoding = "utf-8";

  encode(input = ""): Uint8Array {
    return utf8Encode(String(input));
  }
}

class TextDecoderShim {
  readonly encoding: string;

  constructor(label = "utf-8") {
    const normalized = label.toLowerCase();
    if (!["utf-8", "utf8", "unicode-1-1-utf-8"].includes(normalized)) {
      throw new TypeError(`Unsupported encoding: ${label}`);
    }
    this.encoding = "utf-8";
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) {
      return "";
    }
    return utf8Decode(copyBytes(input));
  }
}

const textEncoder = new TextEncoderShim();
const textDecoder = new TextDecoderShim();

class URLSearchParamsShim {
  #entries: Array<[string, string]> = [];
  #onChange: (() => void) | undefined;

  constructor(init: UrlParamInit = "", onChange?: () => void) {
    this.#onChange = onChange;
    if (typeof init === "string") {
      const source = init.startsWith("?") ? init.slice(1) : init;
      if (!source) {
        return;
      }
      for (const pair of source.split("&")) {
        if (!pair) {
          continue;
        }
        const parts = pair.split("=");
        const key = parts[0] ?? "";
        const value = parts[1] ?? "";
        this.#entries.push([decodeURIComponent(key), decodeURIComponent(value)]);
      }
      return;
    }
    if (init instanceof URLSearchParamsShim) {
      this.#entries = [...init.#entries];
      return;
    }
    if (Array.isArray(init)) {
      this.#entries = init.map(([key, value]) => [String(key), String(value)]);
      return;
    }
    this.#entries = Object.entries(init).map(([key, value]) => [key, String(value)]);
  }

  append(name: string, value: string): void {
    this.#entries.push([String(name), String(value)]);
    this.#onChange?.();
  }

  delete(name: string): void {
    const normalized = String(name);
    this.#entries = this.#entries.filter(([key]) => key !== normalized);
    this.#onChange?.();
  }

  entries(): IterableIterator<[string, string]> {
    return this.#entries[Symbol.iterator]();
  }

  forEach(callback: (value: string, key: string, parent: URLSearchParamsShim) => void): void {
    for (const [key, value] of this.#entries) {
      callback(value, key, this);
    }
  }

  get(name: string): string | null {
    return this.#entries.find(([key]) => key === String(name))?.[1] ?? null;
  }

  getAll(name: string): string[] {
    return this.#entries.filter(([key]) => key === String(name)).map(([, value]) => value);
  }

  has(name: string): boolean {
    return this.#entries.some(([key]) => key === String(name));
  }

  keys(): IterableIterator<string> {
    return this.#entries.map(([key]) => key)[Symbol.iterator]();
  }

  set(name: string, value: string): void {
    const normalizedName = String(name);
    const normalizedValue = String(value);
    const next: Array<[string, string]> = [];
    let replaced = false;
    for (const entry of this.#entries) {
      if (entry[0] !== normalizedName) {
        next.push(entry);
        continue;
      }
      if (!replaced) {
        next.push([normalizedName, normalizedValue]);
        replaced = true;
      }
    }
    if (!replaced) {
      next.push([normalizedName, normalizedValue]);
    }
    this.#entries = next;
    this.#onChange?.();
  }

  toString(): string {
    return this.#entries
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
      .join("&");
  }

  values(): IterableIterator<string> {
    return this.#entries.map(([, value]) => value)[Symbol.iterator]();
  }

  [Symbol.iterator](): IterableIterator<[string, string]> {
    return this.entries();
  }
}

type ParsedUrl = {
  protocol: string;
  host: string;
  pathname: string;
  search: string;
  hash: string;
};

function parseAbsoluteUrl(input: string): ParsedUrl | undefined {
  const match =
    /^(?<protocol>[a-zA-Z][a-zA-Z\d+.-]*:)\/\/(?<host>[^/?#]*)(?<pathname>[^?#]*)?(?<search>\?[^#]*)?(?<hash>#.*)?$/u.exec(
      input,
    );
  if (!match?.groups?.protocol || !match.groups.host) {
    return undefined;
  }
  return {
    protocol: match.groups.protocol,
    host: match.groups.host,
    pathname: match.groups.pathname || "/",
    search: match.groups.search || "",
    hash: match.groups.hash || "",
  };
}

function normalizePathname(pathname: string): string {
  const segments: string[] = [];
  for (const part of pathname.split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  return `/${segments.join("/")}`;
}

function resolveUrl(input: string, base?: string | URLShim): ParsedUrl {
  const absolute = parseAbsoluteUrl(input);
  if (absolute) {
    return absolute;
  }
  if (base === undefined) {
    throw new TypeError(`Invalid URL: ${input}`);
  }
  const baseUrl = base instanceof URLShim ? base : new URLShim(String(base));
  const basePath = baseUrl.pathname.endsWith("/")
    ? baseUrl.pathname
    : baseUrl.pathname.slice(0, baseUrl.pathname.lastIndexOf("/") + 1);
  const [beforeHash, rawHash = ""] = input.split("#");
  const [rawPath, rawSearch = ""] = (beforeHash ?? "").split("?");
  const pathname = rawPath?.startsWith("/") ? rawPath : `${basePath}${rawPath || ""}`;
  return {
    protocol: baseUrl.protocol,
    host: baseUrl.host,
    pathname: normalizePathname(pathname),
    search: rawSearch ? `?${rawSearch}` : "",
    hash: rawHash ? `#${rawHash}` : "",
  };
}

class URLShim {
  readonly host: string;
  readonly hostname: string;
  readonly origin: string;
  readonly password = "";
  readonly port: string;
  readonly protocol: string;
  readonly searchParams: URLSearchParamsShim;
  readonly username = "";
  hash: string;
  pathname: string;
  #search: string;

  constructor(input: string, base?: string | URLShim) {
    const parsed = resolveUrl(String(input), base);
    this.protocol = parsed.protocol;
    this.host = parsed.host;
    const portIndex = this.host.lastIndexOf(":");
    this.hostname = portIndex >= 0 ? this.host.slice(0, portIndex) : this.host;
    this.port = portIndex >= 0 ? this.host.slice(portIndex + 1) : "";
    this.pathname = parsed.pathname;
    this.#search = parsed.search;
    this.hash = parsed.hash;
    this.origin = `${this.protocol}//${this.host}`;
    this.searchParams = new URLSearchParamsShim(this.#search, () => {
      const next = this.searchParams.toString();
      this.#search = next ? `?${next}` : "";
    });
  }

  get href(): string {
    return `${this.origin}${this.pathname}${this.#search}${this.hash}`;
  }

  get search(): string {
    return this.#search;
  }

  toString(): string {
    return this.href;
  }

  toJSON(): string {
    return this.href;
  }
}

class ReadableStreamShim<T = unknown> {
  #queue: T[] = [];
  #closed = false;
  #pending:
    | {
        resolve: (value: { done: boolean; value?: T }) => void;
      }
    | undefined;

  constructor(
    source: {
      start?: (controller: { enqueue: (value: T) => void; close: () => void }) => void;
    } = {},
  ) {
    source.start?.({
      enqueue: (value) => {
        if (this.#pending) {
          this.#pending.resolve({ done: false, value });
          this.#pending = undefined;
          return;
        }
        this.#queue.push(value);
      },
      close: () => {
        this.#closed = true;
        if (this.#pending) {
          this.#pending.resolve({ done: true });
          this.#pending = undefined;
        }
      },
    });
  }

  getReader() {
    return {
      read: async () => {
        if (this.#queue.length > 0) {
          return { done: false, value: this.#queue.shift() as T };
        }
        if (this.#closed) {
          return { done: true, value: undefined };
        }
        return await new Promise<{ done: boolean; value?: T }>((resolve) => {
          this.#pending = { resolve };
        });
      },
    };
  }
}

class WritableStreamShim<T = unknown> {
  #sink: {
    write?: (chunk: T) => unknown;
    close?: () => unknown;
  };

  constructor(sink: { write?: (chunk: T) => unknown; close?: () => unknown } = {}) {
    this.#sink = sink;
  }

  getWriter() {
    return {
      write: async (chunk: T) => {
        await this.#sink.write?.(chunk);
      },
      close: async () => {
        await this.#sink.close?.();
      },
    };
  }
}

class TransformStreamShim<I = unknown, O = unknown> {
  readonly readable: ReadableStreamShim<O>;
  readonly writable: WritableStreamShim<I>;

  constructor(
    transformer: {
      transform?: (chunk: I, controller: { enqueue: (value: O) => void }) => void;
      flush?: (controller: { enqueue: (value: O) => void; close: () => void }) => void;
    } = {},
  ) {
    const queue: O[] = [];
    let closed = false;
    let pending:
      | {
          resolve: (value: { done: boolean; value?: O }) => void;
        }
      | undefined;

    const controller = {
      enqueue: (value: O) => {
        if (pending) {
          pending.resolve({ done: false, value });
          pending = undefined;
          return;
        }
        queue.push(value);
      },
      close: () => {
        closed = true;
        if (pending) {
          pending.resolve({ done: true });
          pending = undefined;
        }
      },
    };

    this.readable = {
      getReader() {
        return {
          read: async () => {
            if (queue.length > 0) {
              return { done: false, value: queue.shift() as O };
            }
            if (closed) {
              return { done: true, value: undefined };
            }
            return await new Promise<{ done: boolean; value?: O }>((resolve) => {
              pending = { resolve };
            });
          },
        };
      },
    } as ReadableStreamShim<O>;

    this.writable = new WritableStreamShim<I>({
      write: async (chunk) => {
        transformer.transform?.(chunk, controller);
      },
      close: async () => {
        transformer.flush?.(controller);
        controller.close();
      },
    });
  }
}

function definePlatformGlobal(
  name: string,
  value: unknown,
  options: { overwrite?: boolean } = {},
): void {
  if (!options.overwrite && name in globalThis) {
    return;
  }
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
}

function formatLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function formatLogLine(args: unknown[]): string {
  return args.map(formatLogArg).join(" ");
}

const platformConsole = {
  log: (...args: unknown[]) => __caplets_log("log", formatLogLine(args)),
  info: (...args: unknown[]) => __caplets_log("info", formatLogLine(args)),
  warn: (...args: unknown[]) => __caplets_log("warn", formatLogLine(args)),
  error: (...args: unknown[]) => __caplets_log("error", formatLogLine(args)),
  debug: (...args: unknown[]) => __caplets_log("debug", formatLogLine(args)),
};

function normalizeEncoding(encoding: string | undefined): BufferEncoding {
  const normalized = (encoding ?? "utf8").toLowerCase();
  switch (normalized) {
    case "utf8":
    case "utf-8":
    case "base64":
    case "base64url":
    case "hex":
      return normalized;
    default:
      throw new TypeError(`Unsupported Buffer encoding: ${encoding}`);
  }
}

function hexToBytes(value: string): Uint8Array {
  if (value.length % 2 !== 0) {
    throw new TypeError("Invalid hex string length");
  }
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    const parsed = Number.parseInt(value.slice(index, index + 2), 16);
    if (Number.isNaN(parsed)) {
      throw new TypeError("Invalid hex string");
    }
    bytes[index / 2] = parsed;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value: string, encoding: BufferEncoding): Uint8Array {
  let normalized = value.replace(/\s+/gu, "");
  if (encoding === "base64url") {
    normalized = normalized.replace(/-/gu, "+").replace(/_/gu, "/");
  }
  const padding = normalized.length % 4;
  if (padding === 1) {
    throw new TypeError("Invalid base64 string");
  }
  if (padding > 0) {
    normalized = normalized.padEnd(normalized.length + (4 - padding), "=");
  }
  const output: number[] = [];
  for (let index = 0; index < normalized.length; index += 4) {
    const chunk = normalized.slice(index, index + 4);
    const values = chunk
      .split("")
      .map((char) => (char === "=" ? 64 : (base64Lookup.get(char) ?? Number.NaN)));
    if (values.some((entry) => Number.isNaN(entry))) {
      throw new TypeError("Invalid base64 string");
    }
    const [a = 0, b = 0, c = 64, d = 64] = values;
    const triple = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
    output.push((triple >> 16) & 255);
    if (c !== 64) {
      output.push((triple >> 8) & 255);
    }
    if (d !== 64) {
      output.push(triple & 255);
    }
  }
  return Uint8Array.from(output);
}

function bytesToBase64(bytes: Uint8Array, encoding: BufferEncoding): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const triple = (a << 16) | (b << 8) | c;
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  if (encoding === "base64url") {
    return output.replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
  }
  return output;
}

function copyBytes(input: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input.slice(0));
  }
  return new Uint8Array(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
}

function toBytes(input: unknown, encoding?: string): Uint8Array {
  if (input instanceof BufferShim) {
    return input.toUint8Array();
  }
  if (typeof input === "string") {
    switch (normalizeEncoding(encoding)) {
      case "utf8":
      case "utf-8":
        return textEncoder.encode(input);
      case "base64":
      case "base64url":
        return base64ToBytes(input, normalizeEncoding(encoding));
      case "hex":
        return hexToBytes(input);
    }
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return copyBytes(input);
  }
  if (Array.isArray(input)) {
    return Uint8Array.from(input);
  }
  throw new TypeError("Buffer.from only supports strings, arrays, ArrayBuffers, and typed arrays");
}

class BufferShim {
  readonly #bytes: Uint8Array;
  readonly byteLength: number;
  readonly length: number;

  private constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.byteLength = bytes.byteLength;
    this.length = bytes.length;
  }

  static from(input: unknown, encoding?: string): BufferShim {
    return new BufferShim(toBytes(input, encoding));
  }

  static isBuffer(value: unknown): value is BufferShim {
    return value instanceof BufferShim;
  }

  static byteLength(input: unknown, encoding?: string): number {
    return toBytes(input, encoding).byteLength;
  }

  toUint8Array(): Uint8Array {
    return new Uint8Array(this.#bytes);
  }

  toString(encoding?: string): string {
    switch (normalizeEncoding(encoding)) {
      case "utf8":
      case "utf-8":
        return textDecoder.decode(this.#bytes);
      case "base64":
      case "base64url":
        return bytesToBase64(this.#bytes, normalizeEncoding(encoding));
      case "hex":
        return bytesToHex(this.#bytes);
    }
  }
}

function atobShim(input: string): string {
  return Array.from(base64ToBytes(String(input), "base64"), (value) =>
    String.fromCharCode(value),
  ).join("");
}

function btoaShim(input: string): string {
  const bytes = new Uint8Array(input.length);
  for (let index = 0; index < input.length; index += 1) {
    const codePoint = input.charCodeAt(index);
    if (codePoint > 255) {
      throw new TypeError("The string to be encoded contains characters outside of Latin1");
    }
    bytes[index] = codePoint;
  }
  return bytesToBase64(bytes, "base64");
}

function queueMicrotaskShim(callback: () => void): void {
  Promise.resolve().then(callback);
}

class AbortSignalShim {
  aborted = false;
  reason: unknown;
  onabort: AbortListener | null = null;
  #listeners = new Set<AbortListener>();

  addEventListener(type: string, listener: AbortListener | null): void {
    if (type === "abort" && listener) {
      this.#listeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: AbortListener | null): void {
    if (type === "abort" && listener) {
      this.#listeners.delete(listener);
    }
  }

  dispatchEvent(event: { type: "abort"; target: AbortSignalShim }): boolean {
    if (event.type !== "abort") {
      return true;
    }
    this.onabort?.(event);
    for (const listener of this.#listeners) {
      listener(event);
    }
    return true;
  }

  throwIfAborted(): void {
    if (this.aborted) {
      throw this.reason ?? new Error("Operation was aborted");
    }
  }

  static abort(reason?: unknown): AbortSignalShim {
    const signal = new AbortSignalShim();
    signal.abort(reason);
    return signal;
  }

  abort(reason?: unknown): void {
    if (this.aborted) {
      return;
    }
    this.aborted = true;
    this.reason = reason;
    this.dispatchEvent({ type: "abort", target: this });
  }
}

class AbortControllerShim {
  readonly signal = new AbortSignalShim();

  abort(reason?: unknown): void {
    this.signal.abort(reason);
  }
}

function cloneFormData(input: FormData): FormData {
  const clone = new FormData();
  for (const [name, value] of input.entries()) {
    if (value instanceof File) {
      clone.append(name, new File([value], value.name, { type: value.type }), value.name);
      continue;
    }
    clone.append(name, value);
  }
  return clone;
}

function cloneBodyValue(input: BodyValue): BodyValue {
  if (input === null || input === undefined || typeof input === "string") {
    return input;
  }
  if (input instanceof FormData) {
    return cloneFormData(input);
  }
  if (input instanceof Blob) {
    return input.slice(0, input.size, input.type);
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return copyBytes(input);
  }
  return input;
}

function blobFromBody(input: BodyValue): Blob {
  if (input instanceof Blob) {
    return input;
  }
  if (typeof input === "string") {
    return new Blob([input], { type: "text/plain;charset=utf-8" });
  }
  if (input instanceof FormData) {
    throw new TypeError("FormData body reading is not supported in Code Mode");
  }
  if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
    return new Blob([copyBytes(input)]);
  }
  return new Blob([]);
}

abstract class BodyMixin {
  protected readonly _bodyInit: BodyValue;
  bodyUsed = false;
  readonly body = null;

  protected constructor(body?: BodyValue) {
    this._bodyInit = cloneBodyValue(body);
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    this.bodyUsed = true;
    return await blobFromBody(this._bodyInit).arrayBuffer();
  }

  async blob(): Promise<Blob> {
    this.bodyUsed = true;
    return blobFromBody(this._bodyInit);
  }

  async formData(): Promise<FormData> {
    this.bodyUsed = true;
    if (this._bodyInit instanceof FormData) {
      return cloneFormData(this._bodyInit);
    }
    throw new TypeError("Body does not contain FormData");
  }

  async json(): Promise<unknown> {
    return JSON.parse(await this.text());
  }

  async text(): Promise<string> {
    this.bodyUsed = true;
    return await blobFromBody(this._bodyInit).text();
  }
}

function toHeaders(init?: HeadersValue): Headers {
  return init instanceof Headers ? new Headers(init) : new Headers(init ?? {});
}

function normalizeMethod(method: string | undefined): string {
  return String(method ?? "GET").toUpperCase();
}

class RequestShim extends BodyMixin {
  readonly headers: Headers;
  readonly method: string;
  readonly signal: AbortSignalShim;
  readonly url: string;

  constructor(
    input: string | URLShim | RequestShim,
    init: {
      method?: string;
      headers?: HeadersValue;
      body?: BodyValue;
      signal?: AbortSignalShim;
    } = {},
  ) {
    const sourceBody = input instanceof RequestShim ? input._bodyInit : undefined;
    super(init.body ?? sourceBody);
    if (input instanceof RequestShim) {
      this.url = input.url;
    } else {
      this.url = input instanceof URLShim ? input.href : new URLShim(String(input)).href;
    }
    this.method = normalizeMethod(
      init.method ?? (input instanceof RequestShim ? input.method : "GET"),
    );
    this.headers = toHeaders(
      init.headers ?? (input instanceof RequestShim ? input.headers : undefined),
    );
    this.signal =
      init.signal ??
      (input instanceof RequestShim ? input.signal : new AbortControllerShim().signal);
  }

  clone(): RequestShim {
    return new RequestShim(this, {
      method: this.method,
      headers: this.headers,
      body: this._bodyInit,
      signal: this.signal,
    });
  }
}

class ResponseShim extends BodyMixin {
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected = false;
  readonly status: number;
  readonly statusText: string;
  readonly type = "default";
  readonly url = "";

  constructor(
    body?: BodyValue,
    init: {
      headers?: HeadersValue;
      status?: number;
      statusText?: string;
    } = {},
  ) {
    super(body);
    this.status = init.status ?? 200;
    this.statusText = init.statusText ?? "";
    this.headers = toHeaders(init.headers);
    this.ok = this.status >= 200 && this.status <= 299;
  }

  clone(): ResponseShim {
    return new ResponseShim(this._bodyInit, {
      headers: this.headers,
      status: this.status,
      statusText: this.statusText,
    });
  }

  static json(
    data: unknown,
    init?: { headers?: HeadersValue; status?: number; statusText?: string },
  ) {
    const headers = toHeaders(init?.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const responseInit: { headers: Headers; status?: number; statusText?: string } = { headers };
    if (init?.status !== undefined) {
      responseInit.status = init.status;
    }
    if (init?.statusText !== undefined) {
      responseInit.statusText = init.statusText;
    }
    return new ResponseShim(JSON.stringify(data), responseInit);
  }
}

function disabledFetch(): never {
  throw new Error(DISABLED_FETCH_MESSAGE);
}

definePlatformGlobal("atob", atobShim);
definePlatformGlobal("btoa", btoaShim);
definePlatformGlobal("Buffer", BufferShim);
definePlatformGlobal("TextEncoder", TextEncoderShim);
definePlatformGlobal("TextDecoder", TextDecoderShim);
definePlatformGlobal("URL", URLShim);
definePlatformGlobal("URLSearchParams", URLSearchParamsShim);
definePlatformGlobal("structuredClone", structuredClone);
definePlatformGlobal("Headers", Headers);
definePlatformGlobal("Blob", Blob);
definePlatformGlobal("File", File);
definePlatformGlobal("FormData", FormData);
definePlatformGlobal("ReadableStream", ReadableStreamShim);
definePlatformGlobal("WritableStream", WritableStreamShim);
definePlatformGlobal("TransformStream", TransformStreamShim);
definePlatformGlobal("AbortController", AbortControllerShim);
definePlatformGlobal("AbortSignal", AbortSignalShim);
definePlatformGlobal("Request", RequestShim);
definePlatformGlobal("Response", ResponseShim);
definePlatformGlobal("queueMicrotask", queueMicrotaskShim);
definePlatformGlobal("console", platformConsole);
definePlatformGlobal("fetch", disabledFetch, { overwrite: true });
