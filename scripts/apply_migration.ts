
import { ensureSchema } from "../lib/db";

(async () => {
  console.log("Applying schema migration...");
  await ensureSchema();
  console.log("Schema migration complete.");
  process.exit(0);
})();
