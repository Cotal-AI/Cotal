/** Native Windows cold-profile creation identity. Run only on a Windows runner. */
import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertRecordIdentity, defaultStartToken, verifyIdentityPin, writePidPair } from "../src/pid.js";

assert.equal(process.platform, "win32", "this suite requires a native Windows runner");
const root = mkdtempSync(join(tmpdir(), "win32-cold-identity-"));
const before = { ...process.env };
const keep = new Set(["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE"]);
const check = (name: string, condition: boolean): void => { assert.ok(condition, name); console.log(`PASS ${name}`); };
try {
  for (const key of Object.keys(process.env)) if (!keep.has(key.toUpperCase())) delete process.env[key];
  for (const name of ["home", "local", "roaming", "tmp"]) mkdirSync(join(root, name));
  Object.assign(process.env, { HOME: join(root, "home"), USERPROFILE: join(root, "home"), LOCALAPPDATA: join(root, "local"), APPDATA: join(root, "roaming"), TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp") });
  const token = defaultStartToken(process.pid);
  check("W1 a cold Windows process has a native creation token", token !== undefined && /^\d{1,20}$/.test(token));
  const path = join(root, "self.pid");
  writePidPair(path, process.pid);
  const pin = verifyIdentityPin(path);
  check("W2 a cold native Windows pin matches its process", pin.kind === "match" && pin.record.token === token);
  check("W3 native Windows creation identity still refuses a changed token", assertRecordIdentity({ pid: process.pid, token: `${token}0` }).kind === "mismatch");
  console.log("WINDOWS COLD CREATION OK (3 checks; native Windows only)");
} finally {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, before);
  rmSync(root, { recursive: true, force: true });
}
