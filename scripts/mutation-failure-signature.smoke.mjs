/** Exercise failure classification with native child results, without running mutations. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSuite } from "../bin/smoke/sentinel.mjs";
import { unmeasurableFailure } from "./mutation-failure-signature.mjs";

const { check, finish } = createSuite();
const root = mkdtempSync(join(tmpdir(), "failure-signature-"));
const run = (program, args, options = {}) => {
  const result = spawnSync(program, args, { cwd: root, encoding: "utf8", ...options });
  return { ...result, output: (result.stdout ?? "") + (result.stderr ?? "") };
};
const detail = (result) => ({ status: result.status, signal: result.signal, code: result.error?.code,
  output: result.output, reason: unmeasurableFailure(result) });
try {
  const timeout = run(process.execPath, ["-e", 'process.stdout.write("started\\n"); setInterval(() => {}, 1000);'],
    { timeout: 2000, killSignal: "SIGKILL" });
  check("the timed-out child actually started", timeout.output.includes("started\n"), detail(timeout));
  check("the native timeout result carries ETIMEDOUT", timeout.error?.code === "ETIMEDOUT", detail(timeout));
  check("the timeout killed the child", timeout.status === null && timeout.signal === "SIGKILL", detail(timeout));
  check("a native timeout is diagnosed as a timeout, not a failure to start",
    unmeasurableFailure(timeout) === "command was killed at its timeout", detail(timeout));

  const missing = run(join(root, "missing-executable"), []);
  check("a missing executable produces native ENOENT", missing.error?.code === "ENOENT", detail(missing));
  check("a missing executable retains the startup diagnosis", unmeasurableFailure(missing)?.startsWith("command could not start:") === true, detail(missing));
  const missingCwd = run(process.execPath, ["-e", "process.exit(0)"], { cwd: join(root, "missing-directory") });
  check("a missing working directory produces native ENOENT", missingCwd.error?.code === "ENOENT", detail(missingCwd));
  check("a missing working directory retains the startup diagnosis", unmeasurableFailure(missingCwd)?.startsWith("command could not start:") === true, detail(missingCwd));
  if (process.platform !== "win32") {
    const blocked = join(root, "not-executable");
    writeFileSync(blocked, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
    const denied = run(blocked, []);
    check("a nonexecutable file produces native EACCES", denied.error?.code === "EACCES", detail(denied));
    check("EACCES retains the startup diagnosis", unmeasurableFailure(denied)?.startsWith("command could not start:") === true, detail(denied));
  } else {
    console.log("POSIX EACCES control not applicable on Windows");
  }
  for (const status of [0, 1]) {
    const ordinary = run(process.execPath, ["-e", `console.log("ordinary result"); process.exit(${status});`]);
    check(`ordinary exit ${status} completes without a spawn error`, ordinary.status === status && !ordinary.error, detail(ordinary));
    check(`ordinary exit ${status} remains measurable`, unmeasurableFailure(ordinary) === undefined, detail(ordinary));
  }
  for (const status of [126, 127]) {
    const unavailable = run(process.execPath, ["-e", `process.exit(${status});`]);
    check(`exit ${status} retains the unavailable diagnosis`, unmeasurableFailure(unavailable) === `command was unavailable (exit ${status})`, detail(unavailable));
  }
  check("a signal without an error does not invent a timeout",
    unmeasurableFailure({ status: null, signal: "SIGKILL", output: "" }) === "command did not produce an exit status (signal SIGKILL)");
  check("an unexplained missing exit status stays unmeasurable",
    unmeasurableFailure({ status: null, signal: null, output: "" }) === "command did not produce an exit status");
  check("an empty ordinary failure stays ambiguous",
    unmeasurableFailure({ status: 1, signal: null, output: "" }) === "red command produced no output, so its verdict is ambiguous");
} finally {
  rmSync(root, { recursive: true, force: true });
}
finish();
