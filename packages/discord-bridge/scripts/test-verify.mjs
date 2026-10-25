/**
 * Decides whether a test run actually ran what it was supposed to. A zero exit code is not enough:
 * `--test-force-exit` was found to exit 0 after a truncated report (a 30-test file reported 19), a
 * test file the runner never listed can register tests that pass without anyone having expected
 * them, and a test file that calls `process.exit(0)` part way through ends "successfully" with
 * some of its tests never run.
 *
 * `records` are what scripts/test-reporter.mjs wrote; `expected` maps each test file to the names of
 * the leaf tests it must report; `discovered` is every test file on disk. Two independent things
 * must hold.
 *
 * 1. The run is complete, judged only from what node:test itself reported about the run, never from
 *    the expected list (so `--update` cannot record a partial run):
 *    - the reporter saw the end of the event stream, and node:test reported the end of the whole run;
 *    - every file reported node:test's own end-of-file summary, exactly once, with nothing failed,
 *      cancelled, skipped or todo. A file whose process ended early never sends one;
 *    - every test and suite node:test registered and scheduled in a file reported a result;
 *    - no file was reported as a whole (node:test does that only when the file's process ended
 *      without its own report), and the summary's counts agree with the results reported.
 * 2. The run is what was expected: the files expected, discovered and reported are one set, and
 *    within a file the reported names are exactly the expected names (a name reported twice is two
 *    tests), so replacing a test by another with the same count is caught.
 *
 * A name is the test's own title. It is stable because titles here are fixed text (a loop that
 * builds titles loops over constants); a title that embeds a time, an id or a random value must not
 * be written.
 */

/** Order strings by UTF-16 code unit: what the default sort does, stated, and independent of the locale. */
export const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const inOrder = (list) => list.every((v, i) => i === 0 || byCodeUnit(list[i - 1], v) <= 0);

const kind = (records, k) => records.filter((r) => r.kind === k);

/** The leaf test results: what the expected list is about. */
export const leafResults = (records) => kind(records, "result").filter((r) => r.type === "test");

/** file -> Map(name -> times reported), plus a problem for every result that is not a plain pass. */
function collect(records) {
  const reported = new Map();
  const problems = [];
  for (const e of leafResults(records)) {
    const names = reported.get(e.file) ?? new Map();
    names.set(e.name, (names.get(e.name) ?? 0) + 1);
    reported.set(e.file, names);
    if (e.status !== "pass") problems.push(`FAILED ${e.file}: ${e.name}`);
    if (e.skip) problems.push(`SKIPPED ${e.file}: ${e.name}`);
    if (e.todo) problems.push(`TODO ${e.file}: ${e.name}`);
    if (e.cancelled) problems.push(`CANCELLED ${e.file}: ${e.name}`);
  }
  // A suite that fails (setup, hook, timeout, or a failing child) fails the run too.
  for (const s of kind(records, "result").filter((r) => r.type === "suite")) {
    if (s.status !== "pass") problems.push(`FAILED ${s.file}: suite: ${s.name}`);
    if (s.skip) problems.push(`SKIPPED ${s.file}: suite: ${s.name}`);
    if (s.todo) problems.push(`TODO ${s.file}: suite: ${s.name}`);
  }
  return { reported, problems };
}

const tally = (keys) => {
  const counts = new Map();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
};

/** Positive evidence, from node:test's own records, that every file and the whole run reached their end. */
function checkCompletion(records, discovered) {
  const problems = [];
  if (kind(records, "end").length !== 1) problems.push("REPORT TRUNCATED: the reporter did not see the end of the run (killed, crashed or cut short)");
  const whole = kind(records, "summary").filter((s) => s.file === null);
  if (whole.length !== 1) problems.push(`RUN INCOMPLETE: node:test reported the end of the whole run ${whole.length} times, expected once`);
  else if (!whole[0].success) problems.push("RUN FAILED: node:test reported the whole run as unsuccessful");

  for (const w of kind(records, "wrapper")) {
    problems.push(`FILE WRAPPER ${w.file}: node:test reported the file as a whole (${w.status}) instead of its tests, which it does only when the file's process ended without its own report`);
  }
  const results = kind(records, "result");
  for (const file of discovered) {
    const summaries = kind(records, "summary").filter((s) => s.file === file);
    if (summaries.length !== 1) {
      problems.push(`INCOMPLETE ${file}: node:test reported the end of this file ${summaries.length} times, expected once (it exited, was killed or never started)`);
    } else {
      const { counts, success } = summaries[0];
      const leaves = results.filter((r) => r.file === file && r.type === "test").length;
      const suites = results.filter((r) => r.file === file && r.type === "suite").length;
      const topLevel = results.filter((r) => r.file === file && r.nesting === 0).length;
      if (!success) problems.push(`INCOMPLETE ${file}: node:test reported this file as unsuccessful`);
      for (const k of ["failed", "cancelled", "skipped", "todo"]) {
        if (counts?.[k] !== 0) problems.push(`INCOMPLETE ${file}: node:test counted ${counts?.[k]} ${k}`);
      }
      if (counts?.tests !== leaves || counts?.passed !== leaves) problems.push(`SUMMARY ${file}: node:test counted ${counts?.tests} tests (${counts?.passed} passed), ${leaves} reported`);
      if (counts?.suites !== suites) problems.push(`SUMMARY ${file}: node:test counted ${counts?.suites} suites, ${suites} reported`);
      if (counts?.topLevel !== topLevel) problems.push(`SUMMARY ${file}: node:test counted ${counts?.topLevel} top-level tests, ${topLevel} reported`);
    }
    // Everything node:test registered and scheduled must have finished: a test it never got to has no result.
    const key = (r) => `${r.nesting}\u0000${r.name}`;
    const registered = tally(kind(records, "enqueue").filter((r) => r.file === file).map(key));
    const finished = tally(results.filter((r) => r.file === file).map(key));
    for (const [k, n] of registered) {
      if ((finished.get(k) ?? 0) < n) problems.push(`NEVER FINISHED ${file}: ${JSON.stringify(k.split("\u0000")[1])} was registered but reported no result`);
    }
    for (const [k, n] of finished) {
      if (n > (registered.get(k) ?? 0)) problems.push(`UNREGISTERED ${file}: ${JSON.stringify(k.split("\u0000")[1])} reported a result node:test never registered`);
    }
  }
  return problems;
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

export function verify({ records, expected, discovered }) {
  const { reported, problems } = collect(records);
  problems.push(...checkCompletion(records, discovered));
  problems.push(...checkFiles({ reported, expected, discovered }));
  const onDisk = new Set(discovered);
  for (const [file, want] of Object.entries(expected)) {
    const got = reported.get(file);
    if (got && onDisk.has(file)) problems.push(...checkNames(file, want, got));
  }
  return { ok: problems.length === 0, problems, total: leafResults(records).length, files: reported.size };
}

/** The expected-tests map for a set of records: file -> leaf test names, in a fixed order. */
export function namesByFile(records) {
  const out = {};
  for (const e of leafResults(records)) (out[e.file] ??= []).push(e.name);
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([file, names]) => [file, names.sort(byCodeUnit)]),
  );
}

/**
 * Parse and check scripts/expected-tests.json. It must be exactly what `--update` writes: an object
 * of file -> array of names, files and names in code-unit order. Anything else is reported rather
 * than trusted, and an unreadable list counts as an empty one.
 */
export function readManifest(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { expected: {}, problems: [`MANIFEST is not valid JSON (${e instanceof Error ? e.message : String(e)}); restore it or rerun --update`] };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { expected: {}, problems: ["MANIFEST must map each test file to its list of test names"] };
  }
  const problems = [];
  const expected = {};
  const files = Object.keys(parsed);
  if (!inOrder(files)) problems.push("MANIFEST files are not in the order --update writes them (edited by hand?)");
  for (const file of files) {
    const names = parsed[file];
    if (!Array.isArray(names) || !names.every((n) => typeof n === "string")) {
      problems.push(`MANIFEST ${file}: must be a list of test names`);
      continue;
    }
    if (!inOrder(names)) problems.push(`MANIFEST ${file}: names are not in the order --update writes them (edited by hand?)`);
    expected[file] = names;
  }
  return { expected, problems };
}
