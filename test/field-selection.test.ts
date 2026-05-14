import { describe, expect, it } from "vitest";
import { CapletsError } from "../src/errors.js";
import { projectStructuredContent } from "../src/field-selection.js";

describe("projectStructuredContent", () => {
  const outputSchema = {
    type: "object",
    properties: {
      id: { type: "string" },
      profile: {
        type: "object",
        properties: {
          name: { type: "string" },
          contact: {
            type: "object",
            properties: {
              email: { type: "string" },
              phone: { type: "string" },
            },
          },
        },
      },
      posts: {
        type: "array",
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            stats: {
              type: "object",
              properties: {
                views: { type: "number" },
              },
            },
          },
        },
      },
    },
  };

  it("projects selected object fields", () => {
    expect(
      projectStructuredContent(
        {
          id: "user-1",
          profile: { name: "Ada", contact: { email: "ada@example.com", phone: "555" } },
        },
        outputSchema,
        ["profile.name"],
      ),
    ).toEqual({ profile: { name: "Ada" } });
  });

  it("projects selected fields from array items", () => {
    expect(
      projectStructuredContent(
        {
          posts: [
            { title: "One", stats: { views: 10 } },
            { title: "Two", stats: { views: 20 } },
          ],
        },
        outputSchema,
        ["posts.title"],
      ),
    ).toEqual({ posts: [{ title: "One" }, { title: "Two" }] });
  });

  it("prunes selected object containers to schema-declared fields", () => {
    expect(
      projectStructuredContent(
        {
          body: { name: "Ada", secret: "hidden" },
        },
        {
          type: "object",
          properties: {
            body: {
              type: "object",
              properties: {
                name: { type: "string" },
              },
            },
          },
        },
        ["body"],
      ),
    ).toEqual({ body: { name: "Ada" } });
  });

  it("prunes selected array containers to schema-declared item fields", () => {
    expect(
      projectStructuredContent(
        {
          items: [
            { title: "One", secret: "hidden" },
            { title: "Two", extra: true },
          ],
        },
        {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  title: { type: "string" },
                },
              },
            },
          },
        },
        ["items"],
      ),
    ).toEqual({ items: [{ title: "One" }, { title: "Two" }] });
  });

  it("preserves selected open-object containers", () => {
    expect(
      projectStructuredContent(
        {
          metadata: { correlationId: "abc", region: "us-east-1" },
        },
        {
          type: "object",
          properties: {
            metadata: { type: "object" },
          },
        },
        ["metadata"],
      ),
    ).toEqual({ metadata: { correlationId: "abc", region: "us-east-1" } });
  });

  it("preserves selected additionalProperties-style containers", () => {
    expect(
      projectStructuredContent(
        {
          metadata: { correlationId: "abc", region: "us-east-1" },
        },
        {
          type: "object",
          properties: {
            metadata: { type: "object", additionalProperties: true },
          },
        },
        ["metadata"],
      ),
    ).toEqual({ metadata: { correlationId: "abc", region: "us-east-1" } });
  });

  it("rejects unknown schema paths", () => {
    expect(() => projectStructuredContent({ profile: {} }, outputSchema, ["profile.age"])).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
  });

  it("requires an output schema", () => {
    expect(() => projectStructuredContent({ id: "user-1" }, undefined, ["id"])).toThrow(
      CapletsError,
    );
    expect(() => projectStructuredContent({ id: "user-1" }, undefined, ["id"])).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
  });

  it("omits selected runtime values that are absent", () => {
    expect(
      projectStructuredContent(
        { profile: { contact: { email: "ada@example.com" } } },
        outputSchema,
        ["id", "profile.name", "profile.contact.email"],
      ),
    ).toEqual({ profile: { contact: { email: "ada@example.com" } } });
  });

  it("requires runtime content to be an object", () => {
    expect(() => projectStructuredContent(null, outputSchema, ["id"])).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
    expect(() => projectStructuredContent([], outputSchema, ["id"])).toThrow(
      expect.objectContaining({ code: "REQUEST_INVALID" }),
    );
  });

  it("projects multiple nested selections", () => {
    expect(
      projectStructuredContent(
        {
          id: "user-1",
          profile: { name: "Ada", contact: { email: "ada@example.com", phone: "555" } },
          posts: [{ title: "One", stats: { views: 10 } }],
        },
        outputSchema,
        ["id", "profile.contact.email", "posts.stats.views"],
      ),
    ).toEqual({
      id: "user-1",
      profile: { contact: { email: "ada@example.com" } },
      posts: [{ stats: { views: 10 } }],
    });
  });

  it("preserves array item cardinality when selected fields are mixed or missing", () => {
    expect(
      projectStructuredContent(
        {
          posts: [{ title: "One" }, { stats: { views: 20 } }],
        },
        outputSchema,
        ["posts.title", "posts.stats.views"],
      ),
    ).toEqual({ posts: [{ title: "One" }, { stats: { views: 20 } }] });
  });

  it("rejects non-dot-path field selection syntax", () => {
    for (const field of [
      "posts.0.title",
      "posts.*.title",
      "posts[*].title",
      "$.profile.name",
      "posts[0].title",
    ]) {
      expect(() => projectStructuredContent({ posts: [] }, outputSchema, [field])).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }),
      );
    }
  });

  it("rejects schema-backed prototype pollution path segments", () => {
    const dangerousSchema = {
      type: "object",
      properties: {
        __proto__: { type: "string" },
        prototype: { type: "string" },
        constructor: { type: "string" },
        safe: {
          type: "object",
          properties: {
            __proto__: { type: "string" },
          },
        },
      },
    };

    for (const field of ["__proto__", "prototype", "constructor", "safe.__proto__"]) {
      expect(() => projectStructuredContent({ safe: {} }, dangerousSchema, [field])).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }),
      );
    }
  });

  it("does not validate inherited schema property names", () => {
    for (const field of ["toString", "hasOwnProperty"]) {
      expect(() => projectStructuredContent({ [field]: "value" }, outputSchema, [field])).toThrow(
        expect.objectContaining({ code: "REQUEST_INVALID" }),
      );
    }
  });

  it("allows non-dangerous Object prototype names when explicitly schema-backed", () => {
    expect(
      projectStructuredContent(
        { toString: "value" },
        { type: "object", properties: { toString: { type: "string" } } },
        ["toString"],
      ),
    ).toEqual({ toString: "value" });
  });
});
