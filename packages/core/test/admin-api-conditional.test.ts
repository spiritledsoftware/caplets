import { describe, expect, it } from "vitest";

import {
  checkCreationPrecondition,
  checkMutationPrecondition,
  createStrongEtag,
} from "../src/admin-api/conditional";

describe("Admin API conditional requests", () => {
  it("creates deterministic strong opaque validators", () => {
    const tag = createStrongEtag("caplet-record", "generation-42");

    expect(createStrongEtag("caplet-record", "generation-42")).toBe(tag);
    expect(tag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(tag).not.toContain("generation-42");
    expect(tag).not.toMatch(/^W\//);
  });
  it("separates resource namespaces using the same version material", () => {
    expect(createStrongEtag("caplet-record", 42)).not.toBe(createStrongEtag("vault-value", 42));
  });

  describe("creation policy", () => {
    it("returns 428 when If-None-Match is missing", () => {
      expect(checkCreationPrecondition(undefined)).toEqual({
        ok: false,
        status: 428,
        code: "PRECONDITION_REQUIRED",
      });
    });

    it("returns 412 for a validator other than the required wildcard", () => {
      expect(checkCreationPrecondition('"existing"')).toEqual({
        ok: false,
        status: 412,
        code: "PRECONDITION_FAILED",
      });
      expect(checkCreationPrecondition('"one", "two"')).toEqual({
        ok: false,
        status: 412,
        code: "PRECONDITION_FAILED",
      });
    });

    it("accepts If-None-Match wildcard with optional whitespace", () => {
      expect(checkCreationPrecondition(" \t* ")).toEqual({ ok: true });
    });
  });

  describe("mutation and deletion policy", () => {
    const currentTag = createStrongEtag("caplet-record", 42);

    it("returns 428 when If-Match is missing", () => {
      expect(checkMutationPrecondition(null, currentTag)).toEqual({
        ok: false,
        status: 428,
        code: "PRECONDITION_REQUIRED",
      });
    });

    it("accepts the current strong validator directly or in a valid list", () => {
      expect(checkMutationPrecondition(currentTag, currentTag)).toEqual({ ok: true });
      expect(
        checkMutationPrecondition(`"other,segment", \t${currentTag}, "third"`, currentTag),
      ).toEqual({ ok: true });
    });

    it("accepts the wildcard for an existing representation", () => {
      expect(checkMutationPrecondition(" \t* ", currentTag)).toEqual({ ok: true });
    });

    it("returns 412 for weak, stale, and malformed validators", () => {
      const staleTag = createStrongEtag("caplet-record", 41);

      expect(checkMutationPrecondition(`W/${currentTag}`, currentTag)).toEqual({
        ok: false,
        status: 412,
        code: "PRECONDITION_FAILED",
      });
      expect(checkMutationPrecondition(staleTag, currentTag)).toEqual({
        ok: false,
        status: 412,
        code: "PRECONDITION_FAILED",
      });
      expect(checkMutationPrecondition(`${staleTag}, *`, currentTag)).toEqual({
        ok: false,
        status: 412,
        code: "PRECONDITION_FAILED",
      });
    });
  });
});
