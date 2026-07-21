import { describe, expect, it } from "vitest";

import { CapletsError } from "../src/errors";
import { problemDetailsFromError, problemResponse } from "../src/admin-api/problem";

describe("Admin API Problem Details", () => {
  it("returns the required RFC 9457 fields with the problem media type", async () => {
    const response = problemResponse(
      new CapletsError("REQUEST_INVALID", "The request is malformed."),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("application/problem+json");
    expect(await response.json()).toEqual({
      type: "urn:caplets:problem:request-invalid",
      title: "Invalid request",
      status: 400,
      detail: "The request is malformed.",
      code: "REQUEST_INVALID",
    });
  });

  it.each([
    ["AUTH_REQUIRED", 401, "Authentication required", "authentication-required"],
    ["SERVER_NOT_FOUND", 404, "Resource not found", "resource-not-found"],
    ["CONFIG_EXISTS", 409, "Conflict", "conflict"],
    ["SERVER_UNAVAILABLE", 503, "Service unavailable", "service-unavailable"],
    ["UPLOAD_CAPACITY_EXCEEDED", 429, "Too many requests", "too-many-requests"],
    ["TOOL_CALL_TIMEOUT", 504, "Gateway timeout", "gateway-timeout"],
    ["INTERNAL_ERROR", 500, "Internal server error", "internal-error"],
  ] as const)("maps %s to its safe HTTP problem class", (code, status, title, typeName) => {
    expect(problemDetailsFromError(new CapletsError(code, "Safe explanation."))).toEqual({
      type: `urn:caplets:problem:${typeName}`,
      title,
      status,
      detail:
        code === "INTERNAL_ERROR" ? "Current Host administration failed." : "Safe explanation.",
      code,
    });
  });

  it("lets the adapter distinguish malformed input from a domain-invalid representation", () => {
    expect(
      problemDetailsFromError(
        new CapletsError("REQUEST_INVALID", "The representation is invalid."),
        {
          status: 422,
        },
      ),
    ).toEqual({
      type: "urn:caplets:problem:representation-invalid",
      title: "Invalid representation",
      status: 422,
      detail: "The representation is invalid.",
      code: "REQUEST_INVALID",
    });
  });

  it("redacts Current Host secrets and replaces raw downstream diagnostics", () => {
    const sensitive = problemDetailsFromError(
      new CapletsError(
        "AUTH_FAILED",
        "Rejected https://service.example/callback?code=secret at /home/operator/config.json with access_token=token-value and Authorization: Bearer bearer-value",
        {
          issues: [{ message: "Zod parse internals" }],
          sql: "select token from credentials",
        },
      ),
    );
    const downstream = problemDetailsFromError(
      new CapletsError(
        "DOWNSTREAM_TOOL_ERROR",
        "PostgreSQL relation vault_values failed on host db.internal",
      ),
    );

    expect(sensitive.detail).toContain("[REDACTED]");
    expect(JSON.stringify(sensitive)).not.toMatch(
      /service\.example|\/home\/operator|token-value|bearer-value|Zod|select token/iu,
    );
    expect(sensitive).not.toHaveProperty("details");
    expect(downstream.detail).toBe("A downstream dependency failed.");
  });

  it("projects only validated extensions supplied by the trusted adapter", () => {
    const error = new CapletsError("CONFIG_EXISTS", "The resource already exists.", {
      nextAction: "untrusted_error_action",
      links: { leaked: "/private/vault-reveals" },
    });

    expect(
      problemDetailsFromError(error, {
        nextAction: "inspect_existing_resource",
        links: {
          resource: "/v2/caplet-records/example",
          reconciliation: "https://admin.example/v2/operations/operation-1",
        },
      }),
    ).toMatchObject({
      nextAction: "inspect_existing_resource",
      links: {
        resource: "/v2/caplet-records/example",
        reconciliation: "https://admin.example/v2/operations/operation-1",
      },
    });

    const invalid = problemDetailsFromError(error, {
      nextAction: "open https://downstream.example/?token=secret",
      links: {
        unsafe: "javascript:alert(1)",
        secret: "/v2/operations/1?token=secret",
      },
    });
    expect(invalid).not.toHaveProperty("nextAction");
    expect(invalid).not.toHaveProperty("links");
  });

  it("turns non-Caplets failures into generic 500 details", () => {
    expect(
      problemDetailsFromError(
        new Error("SQLITE_CONSTRAINT at /var/lib/caplets/state.db using token=database-secret"),
      ),
    ).toEqual({
      type: "urn:caplets:problem:internal-error",
      title: "Internal server error",
      status: 500,
      detail: "Current Host administration failed.",
      code: "INTERNAL_ERROR",
    });
  });
});
