/**
 * A managed dashboard logs an endpoint error by its class only: the error's name and code when each
 * is a short identifier, never its message, which can carry peer-supplied text or a request target.
 *
 * Run: pnpm smoke:web-log-error-class
 */
import { errorClassForLog } from "../src/web.js";

let pass = 0, fail = 0;
const check = (name: string, condition: boolean, detail?: unknown) => {
  if (condition) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, detail ?? ""); }
};

const secret = "launch-token-0123456789abcdef";
class PermissionViolationError extends Error { override name = "PermissionViolationError"; code = "PERMISSIONS_VIOLATION"; }
const named = errorClassForLog(new PermissionViolationError(`denied on ${secret}`));
check("a named error with a code logs both", named === "PermissionViolationError PERMISSIONS_VIOLATION", named);
check("...and never its message", !named.includes(secret), named);

const plain = errorClassForLog(new Error(`rejected request on reply ${secret}`));
check("a plain error logs only its name", plain === "Error", plain);

const hostile = Object.assign(new Error("x"), { name: `bad\u001b[2Jname ${secret}`, code: "a b" });
check("a name or code that is not a short identifier is not printed", errorClassForLog(hostile) === "unclassified", errorClassForLog(hostile));

const numeric = Object.assign(new Error("x"), { code: 503 });
check("an integer code is printed as a token", errorClassForLog(numeric) === "Error 503", errorClassForLog(numeric));
check("a thrown non-error is unclassified", errorClassForLog(secret) === "unclassified", errorClassForLog(secret));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
