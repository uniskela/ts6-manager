import { readFileSync } from "node:fs";
import { healthcheckOk } from "./beta-status.js";

const path = process.env.D1_STATUS_FILE || "evidence/private-beta-status.json";
try {
  const status = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  process.exit(healthcheckOk(status) ? 0 : 1);
} catch {
  process.exit(1);
}
