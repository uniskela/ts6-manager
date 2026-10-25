import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** node:test reporter that writes one JSON line per leaf test, for scripts/run-tests.mjs. */
export default async function* (source) {
  for await (const e of source) {
    if (e.type !== "test:pass" && e.type !== "test:fail") continue;
    if (e.data.details?.type === "suite") {
      // A suite that fails without a failing child (setup, hook, timeout) must still fail the run.
      if (e.type === "test:fail" && !e.data.details?.error?.failureType?.includes?.("subtestsFailed")) {
        yield JSON.stringify({ file: rel(e.data.file), name: `suite: ${e.data.name}`, status: "fail" }) + "\n";
      }
      continue;
    }
    const failureType = e.data.details?.error?.failureType;
    yield JSON.stringify({
      file: rel(e.data.file),
      name: e.data.name,
      status: e.type === "test:pass" ? "pass" : "fail",
      skip: e.data.skip !== undefined && e.data.skip !== false,
      todo: e.data.todo !== undefined && e.data.todo !== false,
      cancelled: failureType === "cancelledByParent",
    }) + "\n";
  }
}

/**
 * The file as a path relative to the package root, which `run-tests.mjs` passes in `D1_TEST_ROOT`.
 * A file outside the root keeps a `..` prefix, so it can never be mistaken for one inside it.
 */
function rel(file) {
  const root = process.env.D1_TEST_ROOT;
  if (!file) return file;
  const path = file.startsWith("file:") ? fileURLToPath(file) : file;
  if (root) return relative(root, path).replaceAll(sep, "/");
  const at = path.indexOf("/discord-bridge/"); // run without the runner
  return at >= 0 ? path.slice(at + "/discord-bridge/".length) : path;
}
