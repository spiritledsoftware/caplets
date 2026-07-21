import { describe, expect, it } from "vitest";
import fixtures from "../../../schemas/caplets-project-binding-v1.fixtures.json";
import {
  PROJECT_BINDING_SOCKET_PROTOCOL,
  bindingTerminalReasonSchema,
  projectBindingSocketClientMessageSchema,
  projectBindingSocketServerMessageSchema,
} from "../src/project-binding/protocol";
import { PROJECT_BINDING_ERROR_CODES, projectBindingRecovery } from "../src/project-binding/errors";

describe("Project Binding v1 protocol fixtures", () => {
  it("covers every client and server message union member", () => {
    expect(fixtures.protocol).toBe(PROJECT_BINDING_SOCKET_PROTOCOL);
    expect(fixtures.client.valid.map(({ message }) => message.type)).toEqual(["heartbeat", "end"]);
    expect(fixtures.server.valid.map(({ message }) => message.type)).toEqual([
      "state",
      "ready",
      "blocked",
      "ended",
    ]);
  });

  it.each(fixtures.client.valid)("accepts valid client message: $name", ({ message }) => {
    expect(projectBindingSocketClientMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each(fixtures.client.invalid)("rejects invalid client message: $name", ({ message }) => {
    expect(projectBindingSocketClientMessageSchema.safeParse(message).success).toBe(false);
  });

  it.each(fixtures.server.valid)("accepts valid server message: $name", ({ message }) => {
    expect(projectBindingSocketServerMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each(fixtures.server.invalid)("rejects invalid server message: $name", ({ message }) => {
    expect(projectBindingSocketServerMessageSchema.safeParse(message).success).toBe(false);
  });

  it("exposes only generic Current Host terminal reasons", () => {
    expect(PROJECT_BINDING_ERROR_CODES).toEqual([
      "project_binding_forbidden",
      "endpoint_unavailable",
      "websocket_upgrade_required",
      "sync_required",
      "sync_failed",
      "sync_size_limit_exceeded",
      "lease_conflict",
      "lease_expired",
      "policy_denied",
      "remote_credentials_required",
      "remote_credentials_revoked",
      "remote_auth_failed",
    ]);
    expect(projectBindingRecovery("sync_size_limit_exceeded")).toMatchObject({
      message: "Project sync size exceeds the remote host policy.",
      recoveryCommand: "Add exclusions to .capletsignore and retry.",
    });
  });

  it.each([
    "cloud_auth_required",
    "cloud_auth_expired",
    "cloud_auth_revoked",
    "workspace_selection_required",
    "workspace_switch_required",
    "workspace_forbidden",
    "usage_limit_reached",
    "billing_required",
    "subscription_past_due",
    "email_verification_required",
  ])("rejects removed hosted terminal reason %s", (code) => {
    expect(bindingTerminalReasonSchema.safeParse({ code, message: "Removed." }).success).toBe(
      false,
    );
  });
});
