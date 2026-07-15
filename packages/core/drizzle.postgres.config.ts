import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/control-plane/schema/postgres.ts",
  out: "./drizzle/postgres",
  casing: "snake_case",
  strict: true,
  verbose: true,
});
