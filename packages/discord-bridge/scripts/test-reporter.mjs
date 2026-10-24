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

function rel(file) {
  const at = file?.indexOf("/discord-bridge/");
  return at >= 0 ? file.slice(at + "/discord-bridge/".length) : file;
}
