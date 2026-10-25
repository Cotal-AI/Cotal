/** Drive the compiled stop's two real pidfile reads without reading argv or signalling a process. */
import { strict as assert } from "node:assert";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock } from "node:test";
import { identityPinPath, stopReservationPath, type LocalProcess } from "@cotal-ai/workspace";
import { stopLocalProcess } from "../dist/lib/local-process-stop.js";

const root = fs.mkdtempSync(join(tmpdir(), "identity-uncertainty-"));
fs.mkdirSync(join(root, ".cotal"));
const component: LocalProcess = { kind: "local-process", name: "fixture", label: "fixture component", pidFile: "fixture.pid" };
const context = { root, space: "fixture" };
const pidfile = join(root, ".cotal", component.pidFile);
const pin = identityPinPath(pidfile);
const readFileSync = fs.readFileSync;
try {
  for (const state of ["missing", "empty", "garbled"] as const) {
    fs.writeFileSync(pidfile, String(process.pid));
    fs.writeFileSync(pin, "preserved pin");
    let reads = 0;
    const reader = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
      const value = readFileSync(...args);
      if (args[0] === pidfile && ++reads === 1) {
        if (state === "missing") fs.unlinkSync(pidfile);
        else fs.writeFileSync(pidfile, state === "empty" ? "" : "not-a-pid");
      }
      return value;
    });
    const kill = mock.method(process, "kill", () => { throw new Error("no process probe or signal was expected"); });
    syncBuiltinESMExports();
    try {
      await assert.rejects(stopLocalProcess(component, context), (error: unknown) => {
        assert(error instanceof Error);
        assert.equal(error.message,
          `refusing to stop fixture component at ${pidfile}: the pidfile no longer records a pid. No signal was sent.\n` +
          `NEXT: inspect the pidfile and rerun this command; the previously read pid ${process.pid} was not used.`);
        return true;
      });
      assert.equal(kill.mock.calls.length, 0);
      assert.equal(readFileSync(pin, "utf8"), "preserved pin");
      assert.equal(fs.existsSync(stopReservationPath(pidfile)), false);
      if (state === "missing") assert.equal(fs.existsSync(pidfile), false);
      else assert.equal(readFileSync(pidfile, "utf8"), state === "empty" ? "" : "not-a-pid");
      console.log(`  pidfile becomes ${state}: specific refusal, no signal, pin preserved, reservation released`);
    } finally {
      reader.mock.restore();
      kill.mock.restore();
      syncBuiltinESMExports();
    }
  }
} finally {
  // No child, watcher or cwd enters this fixture directory.
  fs.rmSync(root, { recursive: true, force: true });
}
