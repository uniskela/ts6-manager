#!/usr/bin/env node
/**
 * Assert the Bridge-D1 invite mask is exactly the five approved flags.
 * Uses discord.js PermissionFlagsBits when available; always checks the documented bits.
 */
const DOC = {
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  UseVAD: 1n << 25n,
  ChangeNickname: 1n << 26n,
};
const APPROVED_NAMES = ["ViewChannel", "Connect", "Speak", "UseVAD", "ChangeNickname"];
const CORRECT = 103810048n;
const PREVIOUS_WRONG = 103809148n;

const docMask = APPROVED_NAMES.reduce((a, n) => a | DOC[n], 0n);
const bitsOf = (n) =>
  Object.entries(DOC)
    .filter(([, b]) => (n & b) === b)
    .map(([name]) => name);

const fail = (m) => {
  console.error(`FAIL  ${m}`);
  process.exitCode = 1;
};
const pass = (m) => console.log(`PASS  ${m}`);

if (docMask !== CORRECT) fail(`documented OR ${docMask} !== ${CORRECT}`);
else pass(`documented OR of five flags = ${CORRECT}`);

if (bitsOf(CORRECT).join(",") !== APPROVED_NAMES.join(",")) fail(`correct mask bits: ${bitsOf(CORRECT)}`);
else pass(`103810048 bits: ${APPROVED_NAMES.join(", ")}`);

if (bitsOf(CORRECT).includes("Administrator")) fail("correct mask includes Administrator");
else pass("103810048 does not include Administrator");

const extra = bitsOf(PREVIOUS_WRONG).filter((n) => !APPROVED_NAMES.includes(n));
const missing = APPROVED_NAMES.filter((n) => !bitsOf(PREVIOUS_WRONG).includes(n));
console.log(`INFO  103809148 bits: ${bitsOf(PREVIOUS_WRONG).join(", ") || "(none of the named flags)"}`);
console.log(`INFO  103809148 extra named flags: ${extra.join(", ") || "(none)"}`);
console.log(`INFO  103809148 missing approved flags: ${missing.join(", ") || "(none)"}`);
console.log(`INFO  103809148 Administrator: ${(PREVIOUS_WRONG & DOC.Administrator) === DOC.Administrator}`);
if (PREVIOUS_WRONG === CORRECT) fail("wrong integer equals correct integer");
else pass("103809148 is not the approved mask");

let lib;
try {
  ({ PermissionFlagsBits: lib } = await import("discord.js"));
} catch {
  console.log("INFO  discord.js not loaded (run inside the lab image to check the library bits)");
}
if (lib) {
  const libMask = APPROVED_NAMES.reduce((a, n) => a | BigInt(lib[n]), 0n);
  if (libMask !== CORRECT) fail(`discord.js OR ${libMask} !== ${CORRECT}`);
  else pass(`discord.js PermissionFlagsBits OR = ${CORRECT}`);
  if (BigInt(lib.Administrator) !== DOC.Administrator) fail("discord.js Administrator bit drifted");
  else pass("discord.js Administrator is 1 << 3 and not in the invite mask");
  for (const n of APPROVED_NAMES) {
    if (BigInt(lib[n]) !== DOC[n]) fail(`discord.js ${n} drifted`);
  }
  const named = Object.entries(lib)
    .filter(([, b]) => typeof b === "bigint" || typeof b === "number")
    .map(([n, b]) => [n, BigInt(b)])
    .filter(([, b]) => (PREVIOUS_WRONG & b) === b)
    .map(([n]) => n);
  console.log(`INFO  103809148 discord.js flags: ${named.join(", ")}`);
}

if (process.exitCode) process.exit(process.exitCode);
console.log("OK    invite permission integer is 103810048");
