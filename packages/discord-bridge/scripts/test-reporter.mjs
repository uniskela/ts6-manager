import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * node:test reporter for scripts/run-tests.mjs. It writes one JSON line per record, and records
 * what the run proves about its own completeness as well as its results:
 *
 * - `enqueue`: a test or suite node:test registered and scheduled. Each must later have a result.
 * - `result`: a test or suite finished (`type` is node:test's own "test" or "suite").
 * - `wrapper`: node:test reported a test file as a whole. That happens only when the file's process
 *   ended without its own report (for example `process.exit(0)` inside a test), so it is never a pass.
 * - `summary`: node:test's count for one file (`file` set), sent when that file's run reached its end,
 *   or for the whole run (`file` null).
 * - `end`: the reporter saw the end of the event stream. A killed or truncated run has none.
 */
export default async function* (source) {
  for await (const e of source) {
    const d = e.data ?? {};
    switch (e.type) {
      case "test:enqueue":
        if (!isWrapper(d)) yield line({ kind: "enqueue", file: rel(d.file), nesting: d.nesting, name: d.name });
        break;
      case "test:pass":
      case "test:fail": {
        const status = e.type === "test:pass" ? "pass" : "fail";
        if (isWrapper(d)) {
          yield line({ kind: "wrapper", file: rel(d.file), status });
          break;
        }
        const failureType = d.details?.error?.failureType;
        yield line({
          kind: "result",
          file: rel(d.file),
          nesting: d.nesting,
          name: d.name,
          type: d.details?.type === "suite" ? "suite" : "test",
          status,
          skip: d.skip !== undefined && d.skip !== false,
          todo: d.todo !== undefined && d.todo !== false,
          cancelled: failureType === "cancelledByParent",
          failureType: failureType ?? null,
        });
        break;
      }
      case "test:summary":
        yield line({ kind: "summary", file: d.file ? rel(d.file) : null, counts: d.counts, success: d.success === true });
        break;
      default:
        break;
    }
  }
  yield line({ kind: "end" });
}

const line = (record) => `${JSON.stringify(record)}\n`;

/**
 * The test node:test creates for a file in its own process: nesting 0 and named by the path the
 * runner passed, which is the path relative to the package root.
 */
function isWrapper(d) {
  return d.nesting === 0 && typeof d.name === "string" && d.file !== undefined && d.name === rel(d.file);
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
