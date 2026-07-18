import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/schema/sqlite.ts",
  out: "./src/storage/drizzle/sqlite",
});
