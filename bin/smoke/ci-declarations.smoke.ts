import { DECLARATIONS, committed, renderDeclaration } from "./gen-ci-suites-dts.mjs";
import { createSuite } from "@cotal-ai/smoke-kit";

const { check, finish, passed, failed } = createSuite();

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
check(`every declaration cell ran (${EXPECTED} before sentinel)`, passed() + failed() === EXPECTED);
console.log(`CI DECLARATIONS SMOKE ${failed() === 0 ? "OK" : "FAILED"} (${passed()} passed, ${failed()} failed)`);
finish();
