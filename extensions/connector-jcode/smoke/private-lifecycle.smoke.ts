import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureProcessIdentity,
  processHasLaunchIdentityForTest,
  readLaunchRecord,
  recordLaunch,
  stopOrphanedTree,
  stopPrivateTree,
  type ProcessIdentityProbe,
} from "../src/private-lifecycle.js";

const operationalFailure = Object.assign(new Error("ps policy denied"), { status: 1 });

assert.throws(
  () =>
    processHasLaunchIdentityForTest(42, "launch-identity", {
      ps: () => {
        throw operationalFailure;
      },
      pidExists: () => true,
    }),
  (error) => error === operationalFailure,
  "a status-1 ps failure for a PID independently proven present must stay loud",
);

const stopped = async (child: ChildProcess, timeoutMs = 5_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(child.pid!, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

// #1179. Drive the ownership decision through a proof source instead of racing a real process's
// dying /proc environ. The bridge stays genuinely alive with the same immutable start token while
// the injected answer selects each state of the proof.
if (process.platform === "linux") {
  const root = mkdtempSync(join(tmpdir(), "cotal-jcode-identity-proof-"));
  const identity = `smoke-${randomBytes(12).toString("base64url")}`;
  const started: ChildProcess[] = [];
  const bridge = (): ChildProcess => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    started.push(child);
    return child;
  };
  const proof = (readEnviron: ProcessIdentityProbe["readEnviron"]): ProcessIdentityProbe => ({
    readEnviron,
    ps: () => "",
    pidExists: () => true,
  });
  const check = (name: string): void => console.log(`  ✓ ${name}`);

  try {
    const broken = bridge();
    const brokenLaunch = captureProcessIdentity(broken.pid!);
    const refusal = `jcode connector: spawned Jcode bridge ${broken.pid} does not carry its launch-bound identity — refusing unsafe teardown`;
    await assert.rejects(
      stopPrivateTree({
        jcodeHome: root,
        launch: brokenLaunch,
        identityValue: identity,
        settleMs: 0,
        identityProbe: proof(() => "PATH=/usr/bin\0"),
      }),
      (error: Error) => error.message === refusal,
      "broken wiring: readable environ without the launch identity refuses with the exact sentence",
    );
    assert.equal(await stopped(broken, 0), false, "the broken-wiring refusal must not signal the unowned bridge");
    check("broken wiring: readable environ without the launch identity refuses with the exact sentence");

    const owned = bridge();
    const ownedLaunch = captureProcessIdentity(owned.pid!);
    await assert.doesNotReject(
      stopPrivateTree({
        jcodeHome: root,
        launch: ownedLaunch,
        identityValue: identity,
        settleMs: 0,
        identityProbe: proof((pid) => pid === owned.pid ? `JCODE_COTAL_LAUNCH_IDENTITY=${identity}\0` : "PATH=/usr/bin\0"),
      }),
      "happy path: readable environ with the launch identity is owned, signalled, and settles",
    );
    assert.ok(await stopped(owned), "the owned bridge must be gone when teardown returns");
    check("happy path: readable environ with the launch identity is owned, signalled, and settles");

    const unprovable: Array<[string, ProcessIdentityProbe["readEnviron"]]> = [
      ["empty environ", () => ""],
      ...(["ENOENT", "ESRCH", "EACCES", "EPERM"] as const).map((code): [string, ProcessIdentityProbe["readEnviron"]] => [
        code,
        () => { throw Object.assign(new Error("environ unavailable during exit"), { code }); },
      ]),
    ];
    for (const [source, readEnviron] of unprovable) {
      const exiting = bridge();
      const exitingLaunch = captureProcessIdentity(exiting.pid!);
      await assert.doesNotReject(
        stopPrivateTree({
          jcodeHome: root,
          launch: exitingLaunch,
          identityValue: identity,
          settleMs: 0,
          identityProbe: proof(readEnviron),
        }),
        `exit window: an unprovable launch identity does not refuse and teardown returns (${source})`,
      );
      assert.ok(await stopped(exiting), `the exiting bridge must be gone when teardown returns (${source})`);
    }
    check("exit window: an unprovable launch identity does not refuse and teardown returns");
  } finally {
    for (const child of started) {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

// #1211. A seat killed without its connector's teardown leaves its Jcode server alive: the server
// setsids into a group of its own and carries no COTAL_NAME, so neither the manager's signal nor a
// name-keyed reap reaches it, and it holds the seat's runtime directory until its own five-minute
// idle timer. The next launch of that seat home adopts it — but only once the connector that owns
// it is provably gone, because the same seat NAME with a LIVE connector is a seat still serving.
if (process.platform !== "win32") {
  const root = mkdtempSync(join(tmpdir(), "cotal-jcode-orphan-"));
  const identity = `smoke-${randomBytes(12).toString("base64url")}`;
  const started: ChildProcess[] = [];
  // Its own process group, as the real daemon has, so the group signal path is the one exercised.
  const sleeper = (carriesIdentity: boolean): ChildProcess => {
    // Whatever runs this suite may itself be a managed agent session, so the ambient copy can carry
    // a live broker URL and credential. These children need neither: they exist to be found by
    // their launch nonce and signalled.
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (key.startsWith("COTAL_")) delete env[key];
    if (carriesIdentity) env.JCODE_COTAL_LAUNCH_IDENTITY = identity;
    else delete env.JCODE_COTAL_LAUNCH_IDENTITY;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { env, stdio: "ignore", detached: true });
    child.unref();
    started.push(child);
    return child;
  };
  const gone = async (pid: number, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };

  try {
    const host = sleeper(false);
    const server = sleeper(true);
    recordLaunch(root, { identity, host: captureProcessIdentity(host.pid!) });

    assert.deepEqual(readLaunchRecord(root)?.identity, identity, "the launch record must name the identity its tree carries");

    // `mode` on writeFileSync applies only to a CREATE, so a record loosened once would stay
    // loosened for the life of the seat home unless every write restates it.
    chmodSync(join(root, "cotal-launch.json"), 0o666);
    recordLaunch(root, { identity, host: captureProcessIdentity(host.pid!) });
    assert.equal(statSync(join(root, "cotal-launch.json")).mode & 0o777, 0o600, "rewriting the launch record must restore owner-only permissions");

    const whileHostLives = await stopOrphanedTree({ home: root });
    assert.deepEqual(whileHostLives, [], "a tree whose connector host is still alive is a live seat and must not be signalled");
    assert.ok(!(await gone(server.pid!, 0)), "the live seat's Jcode process must still be running");

    // The ambiguous record: the host PID is alive but its recorded start token does not match, as a
    // reused PID or a corrupted record would look. Pairing liveness with the token resolved this
    // toward killing, so a live connector kept running while every process carrying its nonce was
    // signalled: two seats under one name, inverted. A live PID at the recorded slot signals nothing.
    recordLaunch(root, { identity, host: { pid: host.pid!, start: "not-the-recorded-token" } });
    const ambiguous = await stopOrphanedTree({ home: root });
    assert.deepEqual(ambiguous, [], "a live PID at the recorded host slot must signal nothing, whatever its start token says");
    assert.ok(!(await gone(server.pid!, 0)), "the tree of a live-PID record must survive the ambiguous case");
    recordLaunch(root, { identity, host: captureProcessIdentity(host.pid!) });

    process.kill(host.pid!, "SIGKILL");
    assert.ok(await gone(host.pid!, 5_000), "the smoke's stand-in connector host must exit before the orphan case");

    const afterHostDied = await stopOrphanedTree({ home: root });
    assert.deepEqual(afterHostDied, [server.pid], "the dead lifecycle's Jcode process must be adopted and stopped");
    assert.ok(await gone(server.pid!, 5_000), "the adopted process must actually be gone");

    assert.deepEqual(await stopOrphanedTree({ home: root }), [], "a record with no surviving process must signal nothing");
  } finally {
    for (const child of started) {
      try {
        process.kill(child.pid!, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
}

console.log("PRIVATE LIFECYCLE SMOKE PASSED (launch identity has owned, missing, and unprovable states; status-1 ps failure stays loud; only a dead lifecycle's Jcode tree is adopted)");
