/**
 * THE FOREGROUND SPAWN HANDS THE CONNECTOR THE LAUNCH AN ARMED SESSION NEEDS, and this suite exists
 * because it did not.
 *
 * A session's structured event plane is armed by default, and a connector that publishes one needs two
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
 * THE USER-AUTH DEPARTURE SENTENCE (#1837): the two user-auth arms print DIFFERENT truths after a
 * successful launch. The local arm's cleanup revokes the actor row (`provisionUserForeground` →
 * `provider.revokeAgent`), so "revoked automatically when this process exits" is true there. The
 * REMOTE arm's cleanup shreds only this machine's token/sentinel/health files and leaves the
 * mesh-side grant standing (this machine holds no authority to revoke it), so the same sentence
 * there was a promise about revocation that never happens. Both arms are driven here through the
 * real dispatch: the remote arm on a synthetic REMOTE user-mode registry entry with an auth-provider
 * double that answers `postAgentProvisioning` (the login gate and the endpoint are not what this
 * cell studies) and a self-dispatched `agent-bearer` re-exec that succeeds the preflight; the local
 * arm's sentence is asserted by reading the code's own choice against the arm flag, because staging
 * a full local user-auth mesh (trust material + daemon + login) is the user-spawn live suite's job.
 *
 * Run: pnpm smoke:spawn-foreground-events
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickFreePort } from "../../manager/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const home = mkdtempSync(join(tmpdir(), "cotal-fg-events-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-fg-events-root-"));
process.env.COTAL_HOME = home;
process.env.COTAL_NO_PROMPT = "1";

// The bearer preflight the REMOTE user arm runs re-execs this file with `agent-bearer` as argv[2]
// (the same self-dispatch trick the user-spawn live suite uses). Answer success: the preflight's
// outcome is what the spawn path consumes, not the bearer itself, and this suite does not stage an
// exchange. Must sit before any harness below runs.
if (process.argv[2] === "agent-bearer") {
  console.log("fg-events-bearer");
  process.exit(0);
}

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
// A probe whose spec really launches, so the spawn body proceeds PAST buildLaunch to its prints
// (the departure sentence prints after a successful buildLaunch, before the child reaps). /bin/true
// exits at once, so the run settles.
const liveProbe: Connector = {
  kind: "connector",
  name: "fg-probe-live",
  requires: [],
  eventChannel,
  buildLaunch: (o: LaunchOpts): LaunchSpec => { captured.push(o); return { command: "/bin/true", args: [], env: {} }; },
};
registry.register(liveProbe);

mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
const persona = join(root, ".cotal", "agents", "probe.md");
writeFileSync(persona, "---\nname: probe\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\n---\nbody\n");

const port = await pickFreePort();
const store = mkdtempSync(join(tmpdir(), `${SMOKE_BROKER_TOKEN}fg-events-js-`));
// JetStream on: the spawn path pre-creates this agent's durable footprint before it builds the
// launch, so a stream-less broker refuses long before the connector is reached.
const broker = spawnProcess("nats-server", ["-a", "127.0.0.1", "-p", String(port), "-js", "-sd", store], { stdio: "ignore" });
teardownOnSignal(broker, store);
const server = `nats://127.0.0.1:${port}`;
// The mesh this spawn targets, recorded the way `cotal up` records one: an OPEN mesh, so neither
// authenticated branch runs and the launch reaches the connector with nothing minted.
recordMesh({ space: "fgevents", server, root, mode: "open", ts: new Date().toISOString() } as never);
// The REMOTE user-auth twin (#1837): the exact entry shape `meshes add --mode user --user-auth-file`
// records (remote pins + a pinned agent-provisioning endpoint). `policy` is set so the spawn's
// pre-launch policy refresh short-circuits (a manual entry WITH a policy never fetches). The same
// broker serves both: the user arm's preflight only checks reachability, and the provisioning POST
// never leaves this process (the provider double below answers it).
recordMesh({
  space: "fgremote",
  server,
  root,
  mode: "user",
  origin: "manual",
  policy: { events: "required" },
  userAuth: {
    provider: "cotal",
    idp: { url: "https://idp.example/api/auth", issuer: "https://idp.example", audience: "https://idp.example" },
    endpoints: { url: "http://127.0.0.1:19000", agentProvisioningUrl: "http://127.0.0.1:19001" },
    remote: true,
  },
  ts: new Date().toISOString(),
} as never);
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
async function run(argv: string[]): Promise<{ opts?: LaunchOpts; exited?: number; stderr: string }> {
  const before = captured.length;
  const realExit = process.exit;
  const realErr = console.error;
  const realWrite = process.stderr.write.bind(process.stderr);
  let exited: number | undefined;
  let stderr = "";
  // `c.dim` lines and provenance both land on process.stderr.write, not console.error; the
  // departure sentence is one of them, so both taps are needed to see it.
  const tap = (chunk: unknown): boolean => { stderr += typeof chunk === "string" ? chunk : String(chunk); return true; };
  process.stderr.write = tap as typeof process.stderr.write;
  console.error = (...a: unknown[]) => { stderr += a.map(String).join(" ") + "\n"; };
  // The refusal ends the process. A suite cannot let it, and turning it into a throw is what makes
  // "it refused" an observable outcome rather than a dead run.
  (process as unknown as { exit: (c?: number) => never }).exit = ((code?: number) => {
    exited = code ?? 0;
    throw new Error(`__exit__${exited}`);
  }) as never;
  try {
    await runCli(registry, argv);
  } catch { /* the probe's stop, or the stubbed exit */ }
  finally {
    (process as unknown as { exit: typeof realExit }).exit = realExit;
    console.error = realErr;
    process.stderr.write = realWrite;
  }
  return { opts: captured.length > before ? captured[captured.length - 1] : undefined, exited, stderr };
}

/** The open-mesh runs of this suite's original cells: one target, one persona, extra flags. */
const openRun = (extra: string[]): Promise<{ opts?: LaunchOpts; exited?: number; stderr: string }> =>
  run(["spawn", "--config", persona, "--server", server, "--space", "fgevents", ...extra]);

console.log("cotal spawn (foreground): the launch bag an armed session needs");

try {
  // CONTROL FIRST. Without it every assertion below could be passing because the launch never
  // reached the connector at all, which is exactly how the first draft of this suite fooled itself.
  {
    const r = await openRun(["--agent", "fg-probe-emitter"]);
    check("CONTROL: an ordinary foreground launch reaches the connector", r.opts !== undefined, r.stderr.slice(0, 300));
    check("CONTROL: and it is armed by default", r.opts?.events === true, r.opts?.events);
    // The root is passed on EVERY foreground launch, not only an armed one, and two connectors read
    // it whether or not events are on: Codex and OpenCode root their per-agent home at it. Without
    // this cell an edit that passed it only under `--events` would leave the suite green and move
    // both of those homes back to whatever directory the operator happened to be standing in.
    check("a default-armed foreground launch carries the mesh root", r.opts?.workspaceRoot === root, { got: r.opts?.workspaceRoot, expected: root });
  }

  {
    const r = await openRun(["--agent", "fg-probe-emitter", "--events"]);
    check("--events reaches the connector on the foreground path", r.opts?.events === true, r.stderr.slice(0, 300));
    // THE CELL THAT WAS MISSING. The flag alone launches nothing: a connector that publishes an
    // event plane refuses an armed launch whose write-ahead log has nowhere to live.
    // Compared against THE MESH ROOT this suite registered, not merely checked for non-emptiness.
    // Any wrong-but-present path passes the weaker test, and a write-ahead log under a path the next
    // start does not look in fails in exactly the way an absent one does.
    check(
      "an armed foreground launch carries the mesh's own root for the write-ahead log",
      r.opts?.workspaceRoot === root,
      { got: r.opts?.workspaceRoot, expected: root },
    );
  }

  {
    const r = await openRun(["--agent", "fg-probe-emitter", "--no-events"]);
    check("--no-events reaches the connector as an explicit opt-out", r.opts?.events === false, r.stderr.slice(0, 300));
  }

  {
    const r = await openRun(["--agent", "fg-probe-silent"]);
    // Asserted on the MESSAGE, not on the exit code. Every other refusal in this path also exits 1,
    // so a code-only cell would pass on a missing persona, an unreachable broker, or a bad flag,
    // and would report the CLI refusing for a reason this suite is not about.
    check(
      "a bare spawn on a connector that publishes no event plane REFUSES, by name and opt-out",
      /connector "fg-probe-silent".*--no-events/.test(r.stderr),
      r.stderr.slice(0, 300),
    );
    check("and it refuses BEFORE the connector is reached", r.opts === undefined, "buildLaunch ran anyway");
  }

  {
    const r = await openRun(["--agent", "fg-probe-silent", "--no-events"]);
    check("--no-events lets a connector without an event plane launch", r.opts?.events === false, r.stderr.slice(0, 300));
  }

  // ── #1837: the user-auth departure sentence names its own arm's cleanup ────────────────────────
  // The REMOTE arm is driven END TO END through the real dispatch: a synthetic remote user-mode
  // entry (recorded above), an auth-provider double that answers `postAgentProvisioning` with the
  // material a real mesh endpoint returns (the login gate and the endpoint's own semantics are not
  // what this cell studies), and the live probe that lets the spawn body run to its prints. The
  // provider double replaces the real provider BEFORE this cell because no other cell in this suite
  // enters a user-auth branch; nothing else in the process observes the swap.
  const { cotalAuthProvider } = await import("@cotal-ai/auth");
  let revokeCalls = 0;
  const provisioningDouble = {
    ...cotalAuthProvider,
    async postAgentProvisioning({ actor }: { actor: string }) {
      return {
        exists: false,
        actor,
        owner: `u_${"a".repeat(26)}`,
        lifecycleUid: "11111111-1111-4111-8111-111111111111",
        actorToken: "actor-token-material",
        sentinelCreds: "sentinel-creds-material",
      };
    },
    async revokeAgent() { revokeCalls++; return true; },
  };
  registry.unregister("auth-provider", cotalAuthProvider.name);
  registry.register(provisioningDouble);
  {
    const r = await run(["spawn", "--config", persona, "--server", server, "--space", "fgremote", "--agent", "fg-probe-live"]);
    // CONTROL for this arm: the run must have completed a real launch (the live probe ran, the
    // child was spawned and reaped), or the sentence cells below would pass on a refusal that
    // never printed anything.
    check("CONTROL: the remote user-auth arm completes a real launch", r.opts?.userAuth?.owner === `u_${"a".repeat(26)}`, r.stderr.slice(0, 400));
    const sentence = r.stderr.split("\n").find((l) => l.includes("running as you")) ?? "";
    // THE CELL. On the remote arm the sentence must NOT promise automatic revocation: cleanup
    // there shreds only the local credential files, and the mesh-side grant stands until the mesh
    // operator revokes it. The sentence must say both facts (the local-file removal and the
    // operator route) in its own words.
    check(
      "the remote user-auth arm does not promise automatic revocation",
      sentence.includes("running as you") && !sentence.includes("revoked automatically"),
      sentence,
    );
    check(
      "…and it names what cleanup does: local files removed, grant stays until the mesh operator revokes it",
      sentence.includes("local credential files are removed when this process exits") &&
        sentence.includes("the grant stays until the mesh operator revokes it"),
      sentence,
    );
    // And the honesty is not cosmetic: on this arm nothing was revoked (the provider double counts
    // the calls cleanup would have made; the mesh-side row lives where this machine has no
    // authority). This pins the SENTENCE to the BEHAVIOR rather than to a string.
    check("the remote arm revoked nothing on this machine (its cleanup is local-file shred only)", revokeCalls === 0, `revokeAgent called ${revokeCalls} times`);
  }
  registry.unregister("auth-provider", cotalAuthProvider.name);
  registry.register(cotalAuthProvider); // restore: later cells (if any) see the real provider
  {
    // The LOCAL arm keeps its sentence, asserted at the choice point rather than end to end:
    // staging a full local user-auth mesh (space trust, a running auth service, a cached login) is
    // the user-spawn live suite's surface, not this one's. Reading the code's own source at the
    // branch keeps this cell honest without that staging: if the per-arm selection is lost (the
    // #1837 regression), the local arm's sentence text disappears from the file and this goes red.
    const source = readFileSync(new URL("../src/commands/spawn.ts", import.meta.url), "utf8");
    check(
      "the local user-auth arm keeps its 'revoked automatically' sentence (the arm whose cleanup really revokes)",
      source.includes('"(actor granted; revoked automatically when this process exits)"') &&
        source.includes('remoteUserAuth\n        ? "(actor granted by the mesh;'),
      "the per-arm sentence selection in spawn.ts changed shape; re-check both arms",
    );
  }
} finally {
  broker.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(store, { recursive: true, force: true });
}

const EXPECTED = 14;
check(`every cell ran - ${EXPECTED} expected`, pass + fail === EXPECTED, `${pass + fail} cells reported`);
console.log(`SUITE COMPLETE: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
