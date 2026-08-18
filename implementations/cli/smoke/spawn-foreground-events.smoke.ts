/**
 * THE FOREGROUND SPAWN HANDS THE CONNECTOR THE LAUNCH AN ARMED SESSION NEEDS, and this suite exists
 * because it did not.
 *
 * `--events` arms a session's structured event plane, and a connector that publishes one needs two
 * things from the launch: the flag, and a workspace root for the emitter's write-ahead log. The
 * manager passed both. This path passed the flag and not the root, so `cotal spawn <persona>
 * --events` failed at launch construction for every armed session while `--detach` worked.
 *
 * NOTHING CAUGHT IT, and the reason is the interesting part. The connector's own suite injects a
 * root in every accepted case, so it proves the connector's contract in isolation and can say
 * nothing about whether a caller honours it. A contract asserted only against itself is how a caller
 * goes missing, so the assertion has to live on the caller's side of the boundary.
 *
 * Real argv through `runCli`, the binary's own dispatch, against a real broker on an OS-assigned
 * loopback port. Open mesh, no trust material on disk, so neither authenticated branch runs: the
 * probe connector records what it was handed and throws, which is after every arming decision and
 * before anything is spawned. Needs `nats-server` on PATH.
 *
 * WHAT IT DOES NOT COVER, stated rather than left to be found. The event GRANT is minted inside the
 * two authenticated branches, which an open mesh does not enter, so the channel landing in
 * `allowPublish` is proved for the manager by `smoke:events-grant` and is not proved here. This
 * suite is about the launch bag and the refusal.
 *
 * Run: pnpm smoke:spawn-foreground-events
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFreePort } from "../../manager/smoke/_free-port.js";

const home = mkdtempSync(join(tmpdir(), "cotal-fg-events-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-fg-events-root-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

// The composition root, exactly as the binary imports it.
await import("../src/index.js");
const { runCli } = await import("../src/command.js");
const { registry, eventChannel } = await import("@cotal-ai/core");
const { recordMesh } = await import("@cotal-ai/workspace");
type LaunchOpts = import("@cotal-ai/core").LaunchOpts;
type LaunchSpec = import("@cotal-ai/core").LaunchSpec;
type Connector = import("@cotal-ai/core").Connector;

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const captured: LaunchOpts[] = [];
const probe = (name: string, emits: boolean): Connector => ({
  kind: "connector",
  name,
  requires: [],
  ...(emits ? { eventChannel } : {}),
  // Records and stops. Returning a real spec would launch a child and wait on it; the fact under
  // test is what this function RECEIVED, which is already decided by the time it runs.
  buildLaunch: (o: LaunchOpts): LaunchSpec => { captured.push(o); throw new Error("__probe_stop__"); },
});
registry.register(probe("fg-probe-emitter", true));
registry.register(probe("fg-probe-silent", false)); // publishes no event plane

mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const persona = join(root, ".cotal", "agents", "probe.md");
writeFileSync(persona, "---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");

const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), "cotal-fg-events-js-"));
// JetStream on: the spawn path pre-creates this agent's durable footprint before it builds the
// launch, so a stream-less broker refuses long before the connector is reached.
const broker = spawnProcess("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
const server = `nats://127.0.0.1:${port}`;
// The mesh this spawn targets, recorded the way `cotal up` records one: an OPEN mesh, so neither
// authenticated branch runs and the launch reaches the connector with nothing minted.
recordMesh({ space: "fgevents", server, root, mode: "open" } as never);
await new Promise<void>((resolve, reject) => {
  const deadline = Date.now() + 15_000;
  const tick = (): void => {
    const probeSock = spawnProcess("nc", ["-z", "127.0.0.1", String(port)], { stdio: "ignore" });
    probeSock.on("exit", (code) => {
      if (code === 0) resolve();
      else if (Date.now() > deadline) reject(new Error(`broker did not come up on ${server}`));
      else setTimeout(tick, 200);
    });
  };
  tick();
});

/** Real argv through the binary's dispatch. Returns what the connector was handed, or how it stopped. */
async function run(extra: string[]): Promise<{ opts?: LaunchOpts; exited?: number; stderr: string }> {
  const before = captured.length;
  const realExit = process.exit;
  const realErr = console.error;
  let exited: number | undefined;
  let stderr = "";
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(" ") + "\n"; };
  // The refusal ends the process. A suite cannot let it, and turning it into a throw is what makes
  // "it refused" an observable outcome rather than a dead run.
  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    exited = code ?? 0;
    throw new Error(`__exit__${exited}`);
  }) as never;
  try {
    await runCli(registry, ["spawn", "--config", persona, "--server", server, "--space", "fgevents", ...extra]);
  } catch { /* the probe's stop, or the stubbed exit */ }
  finally {
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    console.error = realErr;
  }
  return { opts: captured.length > before ? captured[captured.length - 1] : undefined, exited, stderr };
}

console.log("cotal spawn (foreground): the launch bag an armed session needs");

try {
  // CONTROL FIRST. Without it every assertion below could be passing because the launch never
  // reached the connector at all, which is exactly how the first draft of this suite fooled itself.
  {
    const r = await run(["--agent", "fg-probe-emitter"]);
    check("CONTROL: an ordinary foreground launch reaches the connector", r.opts !== undefined, r.stderr.slice(0, 300));
    check("CONTROL: and it is not armed", r.opts?.events !== true, r.opts?.events);
  }

  {
    const r = await run(["--agent", "fg-probe-emitter", "--events"]);
    check("--events reaches the connector on the foreground path", r.opts?.events === true, r.stderr.slice(0, 300));
    // THE CELL THAT WAS MISSING. The flag alone launches nothing: a connector that publishes an
    // event plane refuses an armed launch whose write-ahead log has nowhere to live.
    check(
      "an armed foreground launch carries a workspace root for the write-ahead log",
      typeof r.opts?.workspaceRoot === "string" && r.opts.workspaceRoot.length > 0,
      r.opts?.workspaceRoot,
    );
  }

  {
    const r = await run(["--agent", "fg-probe-silent", "--events"]);
    // Asserted on the MESSAGE, not on the exit code. Every other refusal in this path also exits 1,
    // so a code-only cell would pass on a missing persona, an unreachable broker, or a bad flag,
    // and would report the CLI refusing for a reason this suite is not about.
    check(
      "--events on a connector that publishes no event plane REFUSES, by name",
      /does not publish an AG-UI event plane/.test(r.stderr),
      r.stderr.slice(0, 300),
    );
    check("and it refuses BEFORE the connector is reached", r.opts === undefined, "buildLaunch ran anyway");
  }
} finally {
  broker.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
}

const EXPECTED = 6;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
