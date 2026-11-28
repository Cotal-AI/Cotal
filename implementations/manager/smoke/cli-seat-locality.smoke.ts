/**
 * CLI SEAT-LOCALITY E2E (#383, #397) — the PUBLIC path, through the real binary, on a two-manager
 * mesh. This is the suite the lane owed: every other test here enters through a function, and the
 * defect being fixed lives in the wiring BETWEEN functions, where a suite that calls the callee
 * directly stays green while the command a person types is still broken.
 *
 * Two claims, and only an end-to-end run can make either:
 *
 *  1. `--on` REACHES THE MINT. `cotal ps --on <instance>` must be answered by that instance. The
 *     capability is shaped in core and consumed in the workspace mint, but the argument travels
 *     agents.ts → resolveControlTarget → connectOrExit to get there; drop it anywhere on that chain
 *     and the unit tests still pass while the flag silently returns to timing out.
 *
 *  2. `stop` FINDS THE SEAT WITHOUT BEING TOLD WHERE IT IS. A seat can only be stopped by the
 *     manager hosting it, and the class queue does not know which that is. With two managers and a
 *     seat on exactly one of them, a bare `cotal stop --name <seat>` has to locate it and pin to its
 *     host. Before seat-locality this failed roughly half the time — whenever the queue handed the
 *     request to the manager that does not have the seat — and failed with `no agent "<name>"`,
 *     naming something the operator can see running.
 *
 * The negative control is the third case: a name that exists NOWHERE must still fail, and must fail
 * saying it searched. Without it, "stop found the seat" is indistinguishable from "stop succeeds at
 * everything", and the locality lookup could be a no-op that happens to work.
 *
 * Run: pnpm smoke:cli-seat-locality   (needs nats-server + node on PATH; boots its own broker)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  registry, type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";
import { SMOKE_BROKER_TOKEN, freePort, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "dist", "cotal.js");
const STUB = join(here, "e2e-stub.mjs");

const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

const LIVE_HOST = "broker.cotal.ai";
for (const k of ["COTAL_SERVERS", "COTAL_SERVER", "COTAL_CREDS", "COTAL_SPACE"]) delete process.env[k];
for (const [k, v] of Object.entries(process.env))
  if (typeof v === "string" && v.includes(LIVE_HOST)) throw new Error(`refusing to run: ${k} points at the live broker (${v})`);
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) throw new Error(`this probe only runs against an ephemeral loopback broker; got ${SERVERS}`);
console.log(`broker-url guard: ${SERVERS} is ephemeral loopback; no env var references ${LIVE_HOST}\n`);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ""); }
};

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const UNJOINED = join(dir, "e2e-unjoined.mjs");
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home; // the CLI's mesh registry lives here, never the operator's real one
const space = `cliloc-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  COTAL_E2E_STATUS: "working",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({ kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) } as Connector);
registry.register({ kind: "connector", name: "e2e-unjoined", requires: ["node"], readinessTimeoutMs: 500,
  buildLaunch: (o): LaunchSpec => ({ command: "node", args: [UNJOINED], env: envFor(o) }) } as Connector);

const mkRoot = (tag: string, agentName: string): string => {
  const r = join(dir, tag);
  mkdirSync(join(r, ".cotal", "agents"), { recursive: true });
  writeFileSync(join(r, ".cotal", "agents", `${agentName}.md`), `---\nname: ${agentName}\nrole: worker\n---\n`);
  saveSpaceAuth(authDir(r), auth);
  return r;
};
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

type Run = { status: number | null; out: string };
const cotal = (args: string[], cwd: string, timeoutMs = 90_000): Promise<Run> =>
  new Promise((res) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd, env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); res({ status, out }); });
    child.on("error", (e) => { clearTimeout(timer); res({ status: null, out: `launch error: ${e.message}` }); });
  });

const interactiveJoin = (cwd: string): Promise<Run> =>
  new Promise((res) => {
    const child = pty.spawn(process.execPath, [BIN, "join", "--space", space, "--server", SERVERS], {
      cwd,
      env: { ...process.env, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
      cols: 120,
      rows: 30,
    });
    let out = "";
    let phase = 0;
    child.onData((data) => {
      out += data;
      if (phase === 0 && out.includes("Type to broadcast.")) {
        phase = 1;
        child.write("/working focused repair\r");
      } else if (phase === 1 && out.includes("(you are now working")) {
        phase = 2;
        child.write("/waiting blocked\r");
      } else if (phase === 2 && out.includes("(you are now waiting: blocked)")) {
        phase = 3;
        child.write("/idle\r");
      } else if (phase === 3 && out.includes("(you are now idle)")) {
        phase = 4;
        child.write("/quit\r");
      }
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.onExit(({ exitCode }) => { clearTimeout(timer); res({ status: exitCode, out }); });
  });

type MgrPriv = { managerInstanceId: string };
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1", "seatA"), root2 = mkRoot("ws2", "seatB");
  delivery = await bootDeliveryDaemon({ space, servers: SERVERS, auth, reloadStoreIdentity: workspaceSecretStore(root1).identity! });
  // The registry entry the CLI resolves. Written through the product's own recorder so the shape is
  // whatever `up` would have written, not a hand-built approximation.
  const { recordMesh } = await import("@cotal-ai/workspace");
  for (const r of [root1, root2]) recordMesh({ space, server: SERVERS, root: r, mode: "auth", ts: new Date().toISOString() });

  m1 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root1 });
  m2 = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root2 });
  await m1.start();
  await m2.start();
  const IID1 = (m1 as unknown as MgrPriv).managerInstanceId;
  const IID2 = (m2 as unknown as MgrPriv).managerInstanceId;
  check("two managers are live in one space", IID1 !== IID2, { IID1, IID2 });

  // The seats exist on manager A ONLY. That asymmetry is the whole experiment.
  //
  // SEVERAL of them, deliberately. With two managers a bare `stop` that did NOT locate the seat
  // still lands on the right manager whenever the class queue happens to pick A — so a single-seat
  // run would pass by luck half the time and prove nothing. Requiring N independent stops to ALL
  // succeed drops that to 2^-N; at N=5 a broken build passes about 3% of the time, and the
  // deterministic guard in phase 3 (which does not depend on who answers) closes the rest.
  const SEATS = ["seatA", "seatA2", "seatA3", "seatA4", "seatA5"];
  for (const n of SEATS) {
    writeFileSync(join(root1, ".cotal", "agents", `${n}.md`), `---\nname: ${n}\nrole: worker\n---\n`);
    const r = await m1.startAgent({ name: n, agent: "e2e-stub", cwd: repoRoot, events: false });
    if (!r.ok) { check(`seat ${n} started on manager A`, false, r); }
  }
  check(`all ${SEATS.length} seats are running on manager A (and on no other)`, true);
  await wait(2500);

  console.log("\n1. `cotal ps` sees both managers through the real binary");
  const ps = await cotal(["ps", "--space", space, "--server", SERVERS], root1);
  check("ps exits 0", ps.status === 0, { status: ps.status, out: ps.out.slice(-300) });
  check("ps reports the seat", ps.out.includes("seatA"), ps.out.slice(-300));
  check("ps textual working mesh row names unknown progress", /working · progress unknown/.test(ps.out), ps.out.slice(-1200));

  console.log("\n1b. interactive `cotal join /working` acknowledges presence without claiming observed progress");
  const joined = await interactiveJoin(root1);
  check("interactive join exits 0", joined.status === 0, { status: joined.status, out: joined.out.slice(-1200) });
  check("join /working acknowledgement names unknown progress", joined.out.includes("(you are now working · progress unknown: focused repair)"), joined.out.slice(-1600));
  check("join /waiting acknowledgement semantics stay unchanged", joined.out.includes("(you are now waiting: blocked)"), joined.out.slice(-1600));
  check("join /idle acknowledgement semantics stay unchanged", joined.out.includes("(you are now idle)"), joined.out.slice(-1600));

  console.log("\n2. `cotal ps --on <instance>` is answered by THAT instance (the flag reaches the mint)");
  const psA = await cotal(["ps", "--on", IID1, "--space", space, "--server", SERVERS], root1);
  const psB = await cotal(["ps", "--on", IID2, "--space", space, "--server", SERVERS], root1);
  check("ps --on A exits 0 and shows the seat A hosts", psA.status === 0 && psA.out.includes("seatA"),
    { status: psA.status, out: psA.out.slice(-300) });
  check("ps --on B exits 0 and does NOT show it (a real per-instance view, not the class answer)",
    psB.status === 0 && !psB.out.includes("seatA"), { status: psB.status, out: psB.out.slice(-300) });

  console.log("\n2b. A running process that never joined remains controllable by name");
  writeFileSync(UNJOINED, 'process.stdout.write("unjoined terminal ready\\n"); process.stdin.on("data", d => process.stdout.write(d)); setInterval(() => {}, 1000);\n');
  const unjoinedSeats = ["unjoinedBare", "unjoinedForce", "unjoinedPinned"];
  for (const name of unjoinedSeats) {
    writeFileSync(join(root1, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\nrole: worker\n---\n`);
    await m1.startAgent({ name, agent: "e2e-unjoined", cwd: repoRoot, events: false });
  }
  const unjoinedPs = await cotal(["ps", "--space", space, "--server", SERVERS], root1);
  console.log(`$ cotal ps\n${unjoinedPs.out}`);
  check("ps lists the running seats with degraded joins", unjoinedPs.status === 0 && unjoinedSeats.every(n => unjoinedPs.out.includes(n)) && unjoinedPs.out.includes("join degraded"), unjoinedPs);
  for (const pin of [[], ["--on", IID1]]) {
    const attached = await new Promise<Run>((res) => {
      const child = pty.spawn(process.execPath, [BIN, "attach", "unjoinedBare", "--no-reconnect", ...pin, "--space", space, "--server", SERVERS], {
        cwd: root1, env: { ...process.env, COTAL_SERVERS: "", COTAL_CREDS: "", COTAL_SPACE: "", COTAL_SKIP_CONNECTOR_SEED: "1" }, cols: 120, rows: 30,
      });
      let out = "", detached = false;
      child.onData(data => {
        out += data;
        if (!detached && out.includes("unjoined terminal ready")) { detached = true; child.write("\x1d"); }
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
      child.onExit(({ exitCode }) => { clearTimeout(timer); res({ status: exitCode, out }); });
    });
    check(`attach ${pin.length ? "with explicit manager" : "without pin"} streams the unjoined terminal and detaches`, attached.status === 0 && attached.out.includes("unjoined terminal ready"), attached);
  }
  const input = await cotal(["input", "unjoinedBare", "hello", "--space", space, "--server", SERVERS], root1);
  check("input reaches the unjoined seat", input.status === 0, input);
  for (const [i, name] of unjoinedSeats.entries()) {
    const flags = i === 1 ? ["--force"] : i === 2 ? ["--on", IID1] : [];
    const route = ["--space", space, "--server", SERVERS];
    let stopArgs = ["stop", name, ...flags, ...route];
    if (name === "unjoinedForce") {
      const refused = await cotal([...stopArgs, "--on", "not-a-pin"], root1);
      const retry = refused.out.match(/`(cotal stop [^`]+)`/)?.[1];
      check("a malformed stop pin refuses and the retry keeps the hard stop", refused.status === 1
        && refused.out.includes("not a valid lifecycle token")
        && retry === `cotal stop ${name} --force ${route.join(" ")} --on <instance>`, refused);
      if (!retry) continue;
      stopArgs = retry.replace("<instance>", IID1).split(" ").slice(1);
    }
    const stopped = await cotal(stopArgs, root1);
    console.log(`$ cotal stop ${name} ${flags.join(" ")}\n${stopped.out}`);
    check(`stop ${flags.join(" ") || "without pin"} reaches the unjoined seat in the requested mode`,
      stopped.status === 0 && stopped.out.includes(i === 1 ? "Native mode: hard despawn" : "Native mode: graceful"), stopped);
  }

  const unjoinedAfter = await cotal(["ps", "--space", space, "--server", SERVERS], root1);
  check("all unjoined processes are gone after the acknowledged stops", unjoinedAfter.status === 0 && unjoinedSeats.every(n => !unjoinedAfter.out.includes(n)), unjoinedAfter);

  console.log("\n3. NEGATIVE CONTROL: a name that exists nowhere must fail after a complete manager census");
  const other = join(dir, "other-project");
  mkdirSync(other);
  const prepared = await cotal(["space", "create", "otheraudit"], other);
  const selected = await cotal(["use", "otheraudit"], other);
  const wrongRoster = await cotal(["ps"], other);
  check("another prepared space is selected and bare ps cannot list its agents", prepared.status === 0 && selected.status === 0 && wrongRoster.status === 2 && /Mesh: otheraudit/.test(wrongRoster.out), wrongRoster);
  const route = ["--space", space, "--server", SERVERS];
  const roster = `cotal ps ${route.join(" ")}`;
  const emptyPicker = await new Promise<Run>((res) => {
    const hostEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COTAL_"))) as Record<string, string>;
    const child = pty.spawn(process.execPath, [BIN, "attach", "--on", IID2, ...route], {
      cwd: other, env: { ...hostEnv, COTAL_HOME: home, XDG_CONFIG_HOME: join(home, "xdg"), COTAL_SKIP_CONNECTOR_SEED: "1", NO_COLOR: "1" },
      cols: 180, rows: 30,
    });
    let out = "";
    child.onData((data) => { out += data; });
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    child.onExit(({ exitCode }) => { clearTimeout(timer); res({ status: exitCode, out }); });
  });
  const emptyRoute = `--on ${IID2} ${route.join(" ")}`;
  const [emptyRoster, emptySpawn] = [...emptyPicker.out.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  check("interactive attach with an empty roster keeps the explicit manager, space and broker in both commands",
    emptyPicker.status === 2 && /Code:\s+TARGET_NOT_FOUND/.test(emptyPicker.out)
    && emptyRoster === `cotal ps ${emptyRoute}` && emptySpawn === `cotal spawn ${emptyRoute}`, emptyPicker);
  const emptyRosterResult = emptyRoster === `cotal ps ${emptyRoute}` ? await cotal(emptyRoster.split(" ").slice(1), other) : undefined;
  check("the empty picker's roster command reaches the selected manager",
    emptyRosterResult?.status === 0 && emptyRosterResult.out.includes(IID2) && !emptyRosterResult.out.includes(IID1), emptyRosterResult ?? emptyPicker);
  const noName = await cotal(["attach", ...route], other);
  const [suggestedRoster, suggestedAttach] = [...noName.out.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  check("noninteractive attach without a name keeps the target in both commands",
    noName.status === 1 && noName.out.includes("name the agent to attach without an interactive terminal")
    && suggestedRoster === roster && suggestedAttach === `cotal attach <name> ${route.join(" ")}`, noName);
  const pinnedNoName = await cotal(["attach", "--on", IID1, ...route, "--no-reconnect"], other);
  check("noninteractive attach keeps the manager pin in both commands and the session option in the retry",
    pinnedNoName.status === 1 && pinnedNoName.out.includes(`run \`cotal ps --on ${IID1} ${route.join(" ")}\`, then \`cotal attach <name> --on ${IID1} --no-reconnect ${route.join(" ")}\``), pinnedNoName);
  const shortPin = await cotal(["attach", "--on", "m4k7asdf1234", ...route, "--no-reconnect"], other);
  const [discovery, attachRetry] = [...shortPin.out.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
  check("noninteractive attach diagnoses the malformed pin and suggests an unpinned roster and corrected attach",
    shortPin.status === 1 && shortPin.out.includes("not a valid manager instance id") && discovery === roster
    && attachRetry === `cotal attach <name> --on <instance> --no-reconnect ${route.join(" ")}`, shortPin);
  const discoveryResult = discovery === roster ? await cotal(discovery.split(" ").slice(1), other) : undefined;
  check("the malformed-pin discovery command lists both managers on the specified space",
    discoveryResult?.status === 0 && discoveryResult.out.includes(IID1) && discoveryResult.out.includes(IID2), discoveryResult ?? shortPin);
  const missingStop = await cotal(["stop", ...route, "--json"], other);
  const missingStopEnvelope = JSON.parse(missingStop.out);
  const stopRemedy: string = missingStopEnvelope.error?.remedy ?? "";
  check("nameless stop refuses before target resolution and keeps the explicit route and JSON in its retry",
    missingStop.status === 1 && missingStopEnvelope.error?.code === "USAGE_INVALID" && missingStopEnvelope.target === null
    && stopRemedy === `run \`${roster}\`, then \`cotal stop <name> --json ${route.join(" ")}\``, missingStop);
  const stopRoster = stopRemedy.split("`")[1];
  const stopRosterResult = stopRoster === roster ? await cotal(stopRoster.split(" ").slice(1), other) : undefined;
  check("the nameless stop roster finds the explicit space rather than the selected space",
    stopRosterResult?.status === 0 && stopRosterResult.out.includes(IID1) && stopRosterResult.out.includes(IID2), stopRosterResult ?? missingStop);
  const privateServer = await cotal(["attach", "--space", space, "--server", SERVERS.replace("://", "://user:sensitive-value@")], other);
  check("a broker URL with userinfo is refused without echoing it", privateServer.status === 1
    && privateServer.out.includes("--server must not embed credentials") && !privateServer.out.includes("sensitive-value"), privateServer);
  const ghost = await cotal(["stop", "--name", "no-such-seat", ...route], other);
  check("stop on a nonexistent name exits non-zero", ghost.status !== 0, { status: ghost.status, out: ghost.out.slice(-300) });
  check("...and the error names both managers searched",
    /no managed agent .* on any of the 2 reachable manager/.test(ghost.out) && ghost.out.includes(IID1) && ghost.out.includes(IID2), ghost.out.slice(-600));
  // The same miss with `--on` refuses TARGET_NOT_FOUND, exit 2; the unpinned form refuses the same way.
  check("...as a TARGET_NOT_FOUND refusal, exit 2, with a roster read in the same space and broker",
    ghost.status === 2 && /Code:\s+TARGET_NOT_FOUND/.test(ghost.out) && ghost.out.includes(`run \`${roster}\` to see the agents each manager runs`), ghost.out.slice(-600));
  const misses = await Promise.all([
    cotal(["stop", "--name", "no-such-seat", "--space", space, "--server", SERVERS, "--json"], root1),
    cotal(["input", "no-such-seat", "hello", "--space", space, "--server", SERVERS, "--json"], root1),
    cotal(["attach", "no-such-seat", ...route], other),
  ]);
  check("stop --json and input --json print the refusal envelope, and attach refuses the same way, each exit 2",
    misses.every((r) => r.status === 2 && /TARGET_NOT_FOUND/.test(r.out)) && misses.slice(0, 2).every((r) => r.out.includes('"outcome":"refused"')), misses.map((r) => ({ status: r.status, out: r.out.slice(-400) })));
  check("both JSON misses suggest the JSON roster on the selected route", misses.slice(0, 2).every((r) =>
    JSON.parse(r.out).error?.remedy?.includes(`\`cotal ps --json ${route.join(" ")}\``)), misses.slice(0, 2));
  const pinnedInput = await cotal(["input", "no-such-seat", "hello", "--on", IID1, ...route, "--json"], other);
  const lookup = JSON.parse(pinnedInput.out).error?.remedy?.split("`")[1];
  const copied = lookup === `cotal ps --on ${IID1} --json ${route.join(" ")}` ? await cotal(lookup.split(" ").slice(1), other) : undefined;
  const answering = copied?.status === 0 ? JSON.parse(copied.out).result?.managers : undefined;
  check("the pinned input miss lists only the requested manager in JSON from another project", pinnedInput.status === 2 &&
    answering?.length === 1 && answering[0].instanceId === IID1 && answering[0].state === "answered", pinnedInput);
  check("attach names the same roster read as stop", misses[2]!.out.includes(`run \`${roster}\` to see the agents each manager runs`), misses[2]);
  const follow = suggestedRoster === roster ? await cotal(suggestedRoster.split(" ").slice(1), other) : undefined;
  check("the suggested roster lists both managers instead of the selected space", follow?.status === 0 && follow.out.includes(IID1) && follow.out.includes(IID2), follow ?? noName);
  const pinned = await cotal(["attach", "no-such-seat", "--on", IID1, ...route], other);
  const pinnedRoster = pinned.out.match(/run `([^`]+)` to see the agents the manager runs/)?.[1];
  // The quoted broker URL is one shell argument. Compare the command before following its argv.
  check("a pinned attach miss names the same space, broker and manager", pinned.status === 2 && /TARGET_NOT_FOUND/.test(pinned.out) && pinnedRoster === `cotal ps --on ${IID1} --space ${space} --server '${SERVERS}'`, pinned);
  const pinnedFollow = await cotal(["ps", "--on", IID1, ...route], other);
  check("the pinned roster lists only the named manager", pinnedFollow.status === 0 && pinnedFollow.out.includes(IID1) && !pinnedFollow.out.includes(IID2), pinnedFollow);

  console.log(`\n4. THE CLAIM: bare \`cotal stop --name <seat>\` locates each seat and stops it (x${SEATS.length})`);
  const results: { seat: string; status: number | null; out: string }[] = [];
  for (const n of SEATS) {
    const r = await cotal(["stop", "--name", n, "--space", space, "--server", SERVERS], root1);
    results.push({ seat: n, status: r.status, out: r.out });
  }
  const failed = results.filter((r) => r.status !== 0);
  console.log(`   stops succeeded: ${results.length - failed.length}/${results.length}`);
  check(`ALL ${SEATS.length} stops exit 0 WITHOUT --on (seat-locality found the hosting manager every time)`,
    failed.length === 0, failed.map((f) => ({ seat: f.seat, out: f.out.slice(-220) })));
  // The redesigned stop prints an "Agent stop acknowledged" receipt whose `Agent:` row names the seat.
  const saysStopped = (r: { seat: string; out: string }): boolean => {
    const out = r.out.replace(/\x1b\[[0-9;]*m/g, "");
    return out.includes("Agent stop acknowledged") && new RegExp(`Agent:\\s+${r.seat}\\s`).test(out);
  };
  check("...and each says so", results.every(saysStopped), results.filter((r) => !saysStopped(r)).map((r) => r.seat));

  await wait(2000);
  const psAfter = await cotal(["ps", "--space", space, "--server", SERVERS], root1);
  check("every seat is really gone (the stops acted, they did not merely return 0)",
    psAfter.status === 0 && SEATS.every((n) => !psAfter.out.includes(n)), psAfter.out.slice(-400));

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await m1?.stop({ withAgents: true }).catch(() => {});
  await m2?.stop({ withAgents: true }).catch(() => {});
  await delivery?.stop();
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
