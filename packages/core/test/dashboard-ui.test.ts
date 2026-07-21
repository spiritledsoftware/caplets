import { describe, expect, it } from "vitest";
import { dashboardShell } from "../src/dashboard/routes";

describe("dashboard UI shell", () => {
  it("renders a minimal build-missing fallback instead of an inline dashboard monolith", () => {
    const html = dashboardShell();

    expect(html).toContain("Caplets Admin Dashboard");
    expect(html).toContain("pnpm --filter @caplets/dashboard build");
    expect(html).not.toContain("caplets-service-root-path");
    expect(html).not.toContain('data-action="client-revoke"');
    expect(html).not.toContain("function render(");
  });
});
