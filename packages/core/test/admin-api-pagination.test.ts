import { describe, expect, it } from "vitest";
import { z } from "zod";

import { CapletsError } from "../src/errors";

import {
  createCursorCodec,
  type CursorCodec,
  type CursorJsonValue,
  type CursorPage,
} from "../src/admin-api/pagination";

const capletCursor = createCursorCodec({
  route: "/v2/admin/caplets",
  filters: { state: "active" },
  direction: "asc",
  stableKeySchema: z.object({ name: z.string(), id: z.string() }).strict(),
});

const validEnvelope = {
  version: 1,
  route: "/v2/admin/caplets",
  filters: { state: "active" },
  direction: "asc",
  lastKey: { name: "Calendar", id: "calendar" },
} as const;

function encodeEnvelope(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function expectInvalidCursor(callback: () => unknown): void {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapletsError);
  expect(caught).toMatchObject({
    code: "REQUEST_INVALID",
    message: "Invalid pagination cursor.",
  });
}

describe("Admin API cursor pagination", () => {
  it("round-trips a resource stable key and represents a cursor page", () => {
    const cursor = capletCursor.encode({ name: "Calendar", id: "calendar" });

    expect(capletCursor.decode(cursor)).toEqual({ name: "Calendar", id: "calendar" });

    const page: CursorPage<{ id: string }> = {
      items: [{ id: "calendar" }],
      nextCursor: cursor,
    };
    expect(page).toEqual({ items: [{ id: "calendar" }], nextCursor: cursor });
  });
  it("normalizes filters deterministically into an unpadded base64url envelope", () => {
    const stableKeySchema = z.object({ name: z.string(), id: z.string() }).strict();
    const first = createCursorCodec({
      route: "/v2/admin/caplets",
      filters: {
        state: "active",
        source: { owner: "team", kind: "catalog" },
        tags: ["calendar", "productivity"],
      },
      direction: "desc",
      stableKeySchema,
    });
    const reordered = createCursorCodec({
      route: "/v2/admin/caplets",
      filters: {
        tags: ["calendar", "productivity"],
        source: { kind: "catalog", owner: "team" },
        state: "active",
      },
      direction: "desc",
      stableKeySchema,
    });

    const cursor = first.encode({ name: "Calendar", id: "calendar" });
    expect(reordered.encode({ id: "calendar", name: "Calendar" })).toBe(cursor);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toMatch(/[+/=]/);
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toEqual({
      version: 1,
      route: "/v2/admin/caplets",
      filters: {
        source: { kind: "catalog", owner: "team" },
        state: "active",
        tags: ["calendar", "productivity"],
      },
      direction: "desc",
      lastKey: { id: "calendar", name: "Calendar" },
    });
    expect(reordered.decode(cursor)).toEqual({ name: "Calendar", id: "calendar" });
  });

  it("rejects runtime filter values that are not representable as JSON", () => {
    const circularFilters: Record<string, CursorJsonValue> = {};
    circularFilters.self = circularFilters;

    expectInvalidCursor(() =>
      createCursorCodec({
        route: "/v2/admin/caplets",
        filters: circularFilters,
        direction: "asc",
        stableKeySchema: z.object({ id: z.string() }).strict(),
      }),
    );

    expectInvalidCursor(() =>
      createCursorCodec({
        route: "/v2/admin/caplets",
        filters: { since: new Date("2026-01-01T00:00:00Z") as unknown as CursorJsonValue },
        direction: "asc",
        stableKeySchema: z.object({ id: z.string() }).strict(),
      }),
    );
  });

  it.each([
    ["empty", ""],
    ["standard-base64 padding", `${capletCursor.encode(validEnvelope.lastKey)}=`],
    ["invalid JSON", Buffer.from("{").toString("base64url")],
    ["a non-object envelope", encodeEnvelope([])],
    [
      "a missing envelope field",
      encodeEnvelope({
        version: 1,
        route: validEnvelope.route,
        filters: validEnvelope.filters,
        direction: validEnvelope.direction,
      }),
    ],
    ["an extra envelope field", encodeEnvelope({ ...validEnvelope, unexpected: true })],
    ["an unsupported version", encodeEnvelope({ ...validEnvelope, version: 2 })],
    [
      "a stable key outside the caller schema",
      encodeEnvelope({ ...validEnvelope, lastKey: { name: "Calendar", id: 42 } }),
    ],
  ])("rejects %s cursors with one safe error", (_case, cursor) => {
    expectInvalidCursor(() => capletCursor.decode(cursor));
  });

  it.each([
    [
      "route",
      createCursorCodec({
        route: "/v2/admin/vault-values",
        filters: validEnvelope.filters,
        direction: validEnvelope.direction,
        stableKeySchema: z.object({ name: z.string(), id: z.string() }).strict(),
      }),
    ],
    [
      "normalized filters",
      createCursorCodec({
        route: validEnvelope.route,
        filters: { state: "disabled" },
        direction: validEnvelope.direction,
        stableKeySchema: z.object({ name: z.string(), id: z.string() }).strict(),
      }),
    ],
    [
      "direction",
      createCursorCodec({
        route: validEnvelope.route,
        filters: validEnvelope.filters,
        direction: "desc",
        stableKeySchema: z.object({ name: z.string(), id: z.string() }).strict(),
      }),
    ],
  ] satisfies [string, CursorCodec<{ name: string; id: string }>][])(
    "rejects a cursor bound to a different %s",
    (_binding, codec) => {
      const cursor = capletCursor.encode(validEnvelope.lastKey);
      expectInvalidCursor(() => codec.decode(cursor));
    },
  );
});
