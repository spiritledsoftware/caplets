import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/control-plane/schema/sqlite.ts",
  out: "./drizzle/sqlite",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
