/**
 * Decides whether a test run actually ran what it was supposed to. A zero exit code is not enough:
 * `--test-force-exit` was found to exit 0 after a truncated report (a 30-test file reported 19), and
 * a test file the runner never listed can register tests that pass without anyone having expected them.
 *
 * `events` are the leaf results the reporter wrote ({file, name, status, skip, todo}); `expected`
 * maps each test file to the names of the leaf tests it must report; `discovered` is every test file
 * on disk. Three sets must be exactly the same: the files expected, the files discovered, and the
 * files that reported a result. Within a file the reported names must be exactly the expected names
 * (a name reported twice is two tests), so replacing a test by another with the same count is caught.
 *
 * A name is the test's own title. It is stable because titles here are fixed text (a loop that
 * builds titles loops over constants); a title that embeds a time, an id or a random value must not
 * be written.
 */

/** Order strings by UTF-16 code unit: what the default sort does, stated, and independent of the locale. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** file -> Map(name -> times reported), plus a problem for every result that is not a plain pass. */
function collect(events) {
  const reported = new Map();
  const problems = [];
  for (const e of events) {
    const names = reported.get(e.file) ?? new Map();
    names.set(e.name, (names.get(e.name) ?? 0) + 1);
    reported.set(e.file, names);
    if (e.status !== "pass") problems.push(`FAILED ${e.file}: ${e.name}`);
    if (e.skip) problems.push(`SKIPPED ${e.file}: ${e.name}`);
    if (e.todo) problems.push(`TODO ${e.file}: ${e.name}`);
    if (e.cancelled) problems.push(`CANCELLED ${e.file}: ${e.name}`);
  }
  return { reported, problems };
}

/** The files that exist, are expected and reported must be one set. */
function checkFiles({ reported, expected, discovered }) {
  const problems = [];
  const onDisk = new Set(discovered);
  for (const file of reported.keys()) {
    if (!onDisk.has(file)) problems.push(`UNEXPECTED FILE ${file}: reported test results but is not a discovered test file`);
  }
  for (const file of discovered) {
    if (!(file in expected)) problems.push(`UNLISTED ${file}: a test file with no expected tests (run with --update after reviewing it)`);
    if (!reported.has(file)) problems.push(`NOT RUN ${file}: no test in this file reported a result`);
  }
  for (const file of Object.keys(expected)) {
    if (!onDisk.has(file)) problems.push(`MISSING ${file}: listed in the expected tests but not found on disk`);
  }
  return problems;
}

const tally = (names) => {
  const counts = new Map();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return counts;
};

/** Within one file, the reported names must be exactly the expected names. */
function checkNames(file, want, got) {
  const problems = [];
  const gotCount = [...got.values()].reduce((a, b) => a + b, 0);
  if (gotCount !== want.length) problems.push(`COUNT ${file}: reported ${gotCount} tests, expected ${want.length}`);
  const wanted = tally(want);
  for (const [name, n] of wanted) {
    if ((got.get(name) ?? 0) < n) problems.push(`NOT REPORTED ${file}: ${JSON.stringify(name)}`);
  }
  for (const [name, n] of got) {
    if (n > (wanted.get(name) ?? 0)) problems.push(`UNEXPECTED TEST ${file}: ${JSON.stringify(name)}`);
  }
  return problems;
}

export function verify({ events, expected, discovered }) {
  const { reported, problems } = collect(events);
  problems.push(...checkFiles({ reported, expected, discovered }));
  const onDisk = new Set(discovered);
  for (const [file, want] of Object.entries(expected)) {
    const got = reported.get(file);
    if (got && onDisk.has(file)) problems.push(...checkNames(file, want, got));
  }
  return { ok: problems.length === 0, problems, total: events.length, files: reported.size };
}

/** The expected-tests map for a set of reported events: file -> test names, in a fixed order. */
export function namesByFile(events) {
  const out = {};
  for (const e of events) (out[e.file] ??= []).push(e.name);
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([file, names]) => [file, names.sort(byCodeUnit)]),
  );
}
