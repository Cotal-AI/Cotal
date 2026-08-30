import { DECLARATIONS, committed, renderDeclaration } from "./gen-ci-suites-dts.mjs";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

for (const entry of DECLARATIONS) {
  let emitted: string | undefined;
  let error = "";
  try { emitted = renderDeclaration(entry.module); }
  catch (cause) { error = cause instanceof Error ? cause.message : String(cause); }
  const saved = committed(entry.declaration);
  check(
    `${entry.declaration.split("/").pop()} matches compiler output from its .mjs module`,
    emitted !== undefined && emitted === saved,
    emitted === undefined ? error : saved === undefined ? "declaration missing" : "run pnpm gen:ci-suites-dts",
  );
}

const EXPECTED = DECLARATIONS.length;
check(`every declaration cell ran (${EXPECTED} before sentinel)`, pass + fail === EXPECTED);
console.log(`CI DECLARATIONS SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
