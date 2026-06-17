type CodeModeBufferEncoding = "utf8" | "utf-8" | "base64" | "base64url" | "hex";

interface CodeModeBuffer {
  readonly byteLength: number;
  readonly length: number;
  toString(encoding?: CodeModeBufferEncoding): string;
  toUint8Array(): Uint8Array;
}

interface CodeModeBufferConstructor {
  from(
    input: string | ArrayLike<number> | ArrayBuffer | ArrayBufferView | CodeModeBuffer,
    encoding?: CodeModeBufferEncoding,
  ): CodeModeBuffer;
  isBuffer(value: unknown): value is CodeModeBuffer;
  byteLength(
    input: string | ArrayLike<number> | ArrayBuffer | ArrayBufferView | CodeModeBuffer,
    encoding?: CodeModeBufferEncoding,
  ): number;
}

declare const Buffer: CodeModeBufferConstructor;
declare function atob(input: string): string;
declare function btoa(input: string): string;

type CodeModeURLSearchParamsInit =
  | string
  | Array<[string, string]>
  | Record<string, string>
  | URLSearchParams;

declare class URLSearchParams {
  constructor(init?: CodeModeURLSearchParamsInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  entries(): IterableIterator<[string, string]>;
  forEach(callback: (value: string, key: string, parent: URLSearchParams) => void): void;
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  keys(): IterableIterator<string>;
  set(name: string, value: string): void;
  toString(): string;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class URL {
  constructor(input: string | URL, base?: string | URL);
  readonly hash: string;
  readonly host: string;
  readonly hostname: string;
  readonly href: string;
  readonly origin: string;
  readonly password: string;
  readonly pathname: string;
  readonly port: string;
  readonly protocol: string;
  readonly search: string;
  readonly searchParams: URLSearchParams;
  readonly username: string;
  toJSON(): string;
  toString(): string;
}

declare class TextEncoder {
  readonly encoding: "utf-8";
  encode(input?: string): Uint8Array;
}

declare class TextDecoder {
  readonly encoding: "utf-8";
  constructor(label?: string);
  decode(input?: ArrayBuffer | ArrayBufferView): string;
}

interface CodeModeCrypto {
  randomUUID(): string;
  getRandomValues<T extends ArrayBufferView>(typedArray: T): T;
}

declare const crypto: CodeModeCrypto;
declare function structuredClone<T>(value: T): T;

type CodeModeHeadersInit = Headers | Record<string, string> | Array<[string, string]>;

declare class Headers {
  constructor(init?: CodeModeHeadersInit);
  append(name: string, value: string): void;
  delete(name: string): void;
  entries(): IterableIterator<[string, string]>;
  forEach(callback: (value: string, key: string, parent: Headers) => void): void;
  get(name: string): string | null;
  has(name: string): boolean;
  keys(): IterableIterator<string>;
  set(name: string, value: string): void;
  values(): IterableIterator<string>;
  [Symbol.iterator](): IterableIterator<[string, string]>;
}

type CodeModeBlobPart = string | ArrayBuffer | ArrayBufferView | Blob;
type CodeModeEndingType = "transparent" | "native";

declare class Blob {
  constructor(
    parts?: CodeModeBlobPart[],
    options?: { type?: string; endings?: CodeModeEndingType },
  );
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  slice(start?: number, end?: number, type?: string): Blob;
  text(): Promise<string>;
}

declare class File extends Blob {
  constructor(
    parts: CodeModeBlobPart[],
    name: string,
    options?: { type?: string; lastModified?: number },
  );
  readonly lastModified: number;
  readonly name: string;
}

declare class FormData {
  constructor();
  append(name: string, value: string | Blob, filename?: string): void;
  delete(name: string): void;
  entries(): IterableIterator<[string, string | File]>;
  get(name: string): string | File | null;
  getAll(name: string): Array<string | File>;
  has(name: string): boolean;
  keys(): IterableIterator<string>;
  set(name: string, value: string | Blob, filename?: string): void;
  values(): IterableIterator<string | File>;
  [Symbol.iterator](): IterableIterator<[string, string | File]>;
}

type CodeModeReadableStreamReadResult<T> =
  | { done: false; value: T }
  | { done: true; value?: undefined };

interface ReadableStreamDefaultController<T> {
  enqueue(value: T): void;
  close(): void;
}

interface ReadableStreamDefaultReader<T> {
  read(): Promise<CodeModeReadableStreamReadResult<T>>;
}

declare class ReadableStream<T = unknown> {
  constructor(source?: { start?: (controller: ReadableStreamDefaultController<T>) => void });
  getReader(): ReadableStreamDefaultReader<T>;
}

interface WritableStreamDefaultWriter<T> {
  write(chunk: T): Promise<void>;
  close(): Promise<void>;
}

declare class WritableStream<T = unknown> {
  constructor(sink?: { write?: (chunk: T) => unknown; close?: () => unknown });
  getWriter(): WritableStreamDefaultWriter<T>;
}

interface TransformStreamDefaultController<T> {
  enqueue(value: T): void;
}

declare class TransformStream<I = unknown, O = unknown> {
  constructor(transformer?: {
    transform?: (chunk: I, controller: TransformStreamDefaultController<O>) => void;
    flush?: (controller: ReadableStreamDefaultController<O>) => void;
  });
  readonly readable: ReadableStream<O>;
  readonly writable: WritableStream<I>;
}

type CodeModeAbortListener = (event: { type: "abort"; target: AbortSignal }) => void;

declare class AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  onabort: CodeModeAbortListener | null;
  addEventListener(type: "abort", listener: CodeModeAbortListener | null): void;
  removeEventListener(type: "abort", listener: CodeModeAbortListener | null): void;
  dispatchEvent(event: { type: "abort"; target: AbortSignal }): boolean;
  throwIfAborted(): void;
  static abort(reason?: unknown): AbortSignal;
}

declare class AbortController {
  readonly signal: AbortSignal;
  abort(reason?: unknown): void;
}

type CodeModeBodyInit = Blob | FormData | string | ArrayBuffer | ArrayBufferView | null | undefined;

interface Body {
  readonly body: null;
  readonly bodyUsed: boolean;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare class Request implements Body {
  constructor(
    input: string | URL | Request,
    init?: {
      method?: string;
      headers?: CodeModeHeadersInit;
      body?: CodeModeBodyInit;
      signal?: AbortSignal;
    },
  );
  readonly body: null;
  readonly bodyUsed: boolean;
  readonly headers: Headers;
  readonly method: string;
  readonly signal: AbortSignal;
  readonly url: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  clone(): Request;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare class Response implements Body {
  constructor(
    body?: CodeModeBodyInit,
    init?: { headers?: CodeModeHeadersInit; status?: number; statusText?: string },
  );
  readonly body: null;
  readonly bodyUsed: boolean;
  readonly headers: Headers;
  readonly ok: boolean;
  readonly redirected: false;
  readonly status: number;
  readonly statusText: string;
  readonly type: "default";
  readonly url: "";
  arrayBuffer(): Promise<ArrayBuffer>;
  blob(): Promise<Blob>;
  clone(): Response;
  formData(): Promise<FormData>;
  json(): Promise<unknown>;
  text(): Promise<string>;
  static json(
    data: unknown,
    init?: { headers?: CodeModeHeadersInit; status?: number; statusText?: string },
  ): Response;
}

declare function queueMicrotask(callback: () => void): void;

type CodeModeTimerHandler = (...args: unknown[]) => void;

declare function setTimeout(
  callback: CodeModeTimerHandler,
  delay?: number,
  ...args: unknown[]
): number;
declare function clearTimeout(timerId: number): void;
declare function setInterval(
  callback: CodeModeTimerHandler,
  delay?: number,
  ...args: unknown[]
): number;
declare function clearInterval(timerId: number): void;

export {};
