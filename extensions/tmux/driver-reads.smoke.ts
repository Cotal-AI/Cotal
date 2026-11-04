import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Exercise the built driver through real child-process failures, without using a live tmux server.
// Retain the fixture and call logs so a failed run can be inspected.
if (process.platform === "win32") {
  console.log("tmux driver reads: POSIX scripted executable required");
} else {
  const root = mkdtempSync(join(tmpdir(), "cotal-tmux-driver-reads-"));
  const driver = new URL("./dist/driver.js", import.meta.url).href;
  writeFileSync(join(root, "tmux"), `#!/bin/sh
[ "$1" = -u ] || exit 2
shift
printf '%s\\n' "$*" >> "$TMUX_DRIVER_CALLS"
case "$1" in
  display-message)
    if [ "$3" = '#S' ]; then
      [ "$TMUX_DRIVER_MODE" != session-refused ] || { echo 'probe: session refused' >&2; exit 1; }
      echo fixture-session
    elif [ "$3" = '#{pid}' ]; then
      [ "$TMUX_DRIVER_MODE" != pid-refused ] || { echo 'probe: pid refused' >&2; exit 1; }
      [ "$TMUX_DRIVER_MODE" != restarted ] || { echo 4243; exit 0; }
      echo 4242
    else exit 2; fi;;
  list-panes)
    case "$TMUX_DRIVER_MODE" in
      list-refused) echo 'probe: list refused' >&2; exit 1;;
      no-server) echo 'no server running on fixture-socket' >&2; exit 1;;
      missing) exit 0;;
      dead|capture-dead) echo '%1 1';;
      *) echo '%1 0';;
    esac;;
  capture-pane)
    case "$TMUX_DRIVER_MODE" in
      capture-refused|capture-dead|missing|no-server|list-refused)
        echo 'probe: capture refused' >&2; exit 1;;
      *) printf 'hello from the pane\\n';;
    esac;;
  *) exit 2;;
esac
`, { mode: 0o700 });

  interface Failure {
    message: string;
    cause?: { message: string; stderr: string; status: number };
  }
  let serial = 0;
  function read(mode: string, call: string, inside = true) {
    const callsPath = join(root, `calls-${serial++}`);
    writeFileSync(callsPath, "");
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import * as driver from ${JSON.stringify(driver)};
      try {
        console.log(JSON.stringify({ returned: ${call} }));
      } catch (error) {
        const cause = error.cause;
        console.log(JSON.stringify({ error: {
          message: error.message,
          cause: cause && { message: cause.message, stderr: String(cause.stderr), status: cause.status }
        } }));
      }
    `], {
      cwd: root,
      env: {
        PATH: `${root}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: root,
        TMUX_DRIVER_MODE: mode,
        TMUX_DRIVER_CALLS: callsPath,
        ...(inside ? { TMUX: "fixture-socket,4242,0" } : {}),
      },
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    return {
      result: JSON.parse(child.stdout) as { returned?: string; error?: Failure },
      stderr: child.stderr,
      calls: readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean),
    };
  }

  function failure(mode: string, call: string, operation: string, command: string, stderr: string) {
    const got = read(mode, call);
    assert.ok(got.result.error, "read must throw");
    assert.ok(got.result.error.message.startsWith(`tmux: couldn't ${operation}: ${stderr}`), got.result.error.message);
    assert.ok(got.result.error.cause, "failed tmux call must be retained as cause");
    assert.ok(got.result.error.cause.message.startsWith(`Command failed: tmux -u ${command}`));
    assert.equal(got.result.error.cause.stderr, `${stderr}\n`);
    assert.equal(got.result.error.cause.status, 1);
    assert.equal(got.stderr, "", "failed tmux stderr must not leak outside the error");
    return got;
  }

  test("currentSession preserves its success result", () => {
    const got = read("ok", "driver.currentSession()");
    assert.deepEqual(got.result, { returned: "fixture-session" });
    assert.deepEqual(got.calls, ["display-message -p #S"]);
  });
  test("capturePane preserves its screen and checks pane and server", () => {
    const got = read("ok", 'driver.capturePane("%1", "4242")');
    assert.deepEqual(got.result, { returned: "hello from the pane\n" });
    assert.deepEqual(got.calls, ["capture-pane -p -t %1", "list-panes -a -F #{pane_id} #{pane_dead}", "display-message -p #{pid}"]);
  });
  test("currentSession names the failed read, retains its cause and captures stderr", () => {
    const got = failure("session-refused", "driver.currentSession()", "read current session name", "display-message -p #S", "probe: session refused");
    assert.deepEqual(got.calls, ["display-message -p #S"]);
  });
  test("capturePane names the failed read and retains its cause for a running pane", () => {
    const got = failure("capture-refused", 'driver.capturePane("%1", "4242")', "capture pane %1", "capture-pane -p -t %1", "probe: capture refused");
    assert.deepEqual(got.calls, ["capture-pane -p -t %1", "list-panes -a -F #{pane_id} #{pane_dead}"]);
  });
  test("currentSession outside tmux refuses without invoking tmux", () => {
    const got = read("ok", "driver.currentSession()", false);
    assert.deepEqual(got.result, { error: { message: "tmux: not inside a tmux session ($TMUX is not set)" } });
    assert.deepEqual(got.calls, []);
  });
  for (const mode of ["capture-dead", "missing", "no-server", "dead", "restarted"]) {
    test(`capturePane still returns undefined for ${mode}`, () => {
      assert.deepEqual(read(mode, 'driver.capturePane("%1", "4242")').result, {});
    });
  }
  test("capturePane fails closed when the exit probe fails", () => {
    failure("list-refused", 'driver.capturePane("%1", "4242")', "prove pane %1 exited", "list-panes -a -F #{pane_id} #{pane_dead}", "probe: list refused");
  });
  test("capturePane fails closed when the server probe fails", () => {
    failure("pid-refused", 'driver.capturePane("%1", "4242")', "read the server pid", "display-message -p #{pid}", "probe: pid refused");
  });
  console.log(`tmux driver read fixtures: ${root}`);
}
