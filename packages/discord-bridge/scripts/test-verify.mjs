/**
 * Decides whether a test run actually ran what it was supposed to. A zero exit code is not enough:
 * `--test-force-exit` was found to exit 0 after a truncated report (a 30-test file reported 19).
 *
 * `events` are the leaf results the reporter wrote ({file, name, status, skip, todo}); `expected`
 * maps each test file to the number of leaf tests it must report; `discovered` is every test file on disk.
 */
export function verify({ events, expected, discovered }) {
  const problems = [];
  const perFile = new Map();
  for (const e of events) {
    const f = perFile.get(e.file) ?? { total: 0, pass: 0 };
    f.total += 1;
    if (e.status === "pass" && !e.skip && !e.todo) f.pass += 1;
    perFile.set(e.file, f);
    if (e.status !== "pass") problems.push(`FAILED ${e.file}: ${e.name}`);
    if (e.skip) problems.push(`SKIPPED ${e.file}: ${e.name}`);
    if (e.todo) problems.push(`TODO ${e.file}: ${e.name}`);
    if (e.cancelled) problems.push(`CANCELLED ${e.file}: ${e.name}`);
  }
  for (const file of discovered) {
    if (!(file in expected)) problems.push(`UNLISTED ${file}: a test file with no expected count (run with --update after reviewing it)`);
    if (!perFile.has(file)) problems.push(`NOT RUN ${file}: no test in this file reported a result`);
  }
  for (const [file, want] of Object.entries(expected)) {
    if (!discovered.includes(file)) problems.push(`MISSING ${file}: listed in the expected counts but not found on disk`);
    const got = perFile.get(file)?.total ?? 0;
    if (perFile.has(file) && got !== want) problems.push(`COUNT ${file}: reported ${got} tests, expected ${want}`);
  }
  const total = events.length;
  return { ok: problems.length === 0, problems, total, files: perFile.size };
}
