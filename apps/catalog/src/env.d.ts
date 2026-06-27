import "../.astro/types.d.ts";

import type { Runtime } from "@astrojs/cloudflare";
import type { D1Database } from "@cloudflare/workers-types";

declare global {
  namespace App {
    interface Locals extends Runtime {}
  }
}

interface Env {
  CATALOG_DB?: D1Database;
}
