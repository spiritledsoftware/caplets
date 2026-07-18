import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/storage/schema/postgres.ts",
  out: "./src/storage/drizzle/postgres",
});
