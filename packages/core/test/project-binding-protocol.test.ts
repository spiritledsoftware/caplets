import { describe, expect, it } from "vitest";
import fixtures from "../../../schemas/caplets-project-binding-v1.fixtures.json";
import {
  PROJECT_BINDING_SOCKET_PROTOCOL,
  projectBindingSocketClientMessageSchema,
  projectBindingSocketServerMessageSchema,
} from "../src/project-binding/protocol";

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
});
