import { describe, expect, it } from "vitest";
import {
  PROJECT_BINDING_STATES,
  projectBindingConnectUrl,
  projectBindingStatusUrl,
  type ProjectBindingState,
} from "../src/project-binding/routes";

describe("project binding routes", () => {
  it("derives the connect URL from a hosted base URL", () => {
    expect(projectBindingConnectUrl("https://example.com/caplets")).toBe(
      "https://example.com/caplets/v1/attach/project-bindings/connect",
    );
  });

  it("derives a binding status URL from a hosted base URL", () => {
    expect(projectBindingStatusUrl("https://example.com/caplets", "bind_123")).toBe(
      "https://example.com/caplets/v1/attach/project-bindings/bind_123/status",
    );
  });

  it("exposes the exact project binding states", () => {
    const states: ProjectBindingState[] = [
      "not_attached",
      "attaching",
      "syncing",
      "ready",
      "degraded",
      "blocked",
      "offline",
      "cleaning_up",
      "ended",
      "expired",
    ];
    expect(PROJECT_BINDING_STATES).toEqual(states);
  });
});
