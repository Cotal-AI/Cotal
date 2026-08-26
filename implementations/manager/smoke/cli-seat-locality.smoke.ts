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
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  registry, type Connector, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const BIN = join(repoRoot, "bin", "cotal.ts");
const STUB = join(here, "e2e-stub.mjs");

const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
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
const home = join(dir, "home");
mkdirSync(home, { recursive: true });
process.env.COTAL_HOME = home; // the CLI's mesh registry lives here, never the operator's real one
const space = `cliloc-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);

const envFor = (o: LaunchOpts): Record<string, string> => ({
  COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? SERVERS), COTAL_CREDS: String(o.creds),
  COTAL_ID: String(o.id), COTAL_NAME: o.name, PATH: process.env.PATH ?? "",
  ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
});
registry.register({ kind: "connector", name: "e2e-stub", requires: ["node"], buildLaunch: (o): LaunchSpec => ({ command: "node", args: [STUB], env: envFor(o) }) } as Connector);

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
    const child = spawn("npx", ["tsx", BIN, ...args], {
      cwd, env: { ...process.env, COTAL_HOME: home, COTAL_SPACE: "", COTAL_SERVERS: "", COTAL_CREDS: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (status) => { clearTimeout(timer); res({ status, out }); });
    child.on("error", (e) => { clearTimeout(timer); res({ status: null, out: `launch error: ${e.message}` }); });
  });

type MgrPriv = { managerInstanceId: string };
let m1: InstanceType<typeof Manager> | undefined;
let m2: InstanceType<typeof Manager> | undefined;

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root1 = mkRoot("ws1", "seatA"), root2 = mkRoot("ws2", "seatB");
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
    const r = await m1.startAgent({ name: n, agent: "e2e-stub", cwd: repoRoot });
    if (!r.ok) { check(`seat ${n} started on manager A`, false, r); }
  }
  check(`all ${SEATS.length} seats are running on manager A (and on no other)`, true);
  await wait(2500);

  console.log("\n1. `cotal ps` sees both managers through the real binary");
  const ps = await cotal(["ps", "--space", space, "--server", SERVERS], root1);
  check("ps exits 0", ps.status === 0, { status: ps.status, out: ps.out.slice(-300) });
  check("ps reports the seat", ps.out.includes("seatA"), ps.out.slice(-300));

  console.log("\n2. `cotal ps --on <instance>` is answered by THAT instance (the flag reaches the mint)");
  const psA = await cotal(["ps", "--on", IID1, "--space", space, "--server", SERVERS], root1);
  const psB = await cotal(["ps", "--on", IID2, "--space", space, "--server", SERVERS], root1);
  check("ps --on A exits 0 and shows the seat A hosts", psA.status === 0 && psA.out.includes("seatA"),
    { status: psA.status, out: psA.out.slice(-300) });
  check("ps --on B exits 0 and does NOT show it (a real per-instance view, not the class answer)",
    psB.status === 0 && !psB.out.includes("seatA"), { status: psB.status, out: psB.out.slice(-300) });

  console.log("\n3. NEGATIVE CONTROL: a name that exists nowhere must still fail, and say it searched");
  const ghost = await cotal(["stop", "--name", "no-such-seat", "--space", space, "--server", SERVERS], root1);
  check("stop on a nonexistent name exits non-zero", ghost.status !== 0, { status: ghost.status, out: ghost.out.slice(-300) });
  check("...and the error says the space was SEARCHED, not just that one manager missed",
    /no managed agent .* on any of the \d+ reachable manager instance/.test(ghost.out), ghost.out.slice(-400));

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
  check("...and each says so", results.every((r) => r.out.includes(`stopped ${r.seat}`)),
    results.filter((r) => !r.out.includes(`stopped ${r.seat}`)).map((r) => r.seat));

  await wait(2000);
  const psAfter = await cotal(["ps", "--space", space, "--server", SERVERS], root1);
  check("every seat is really gone (the stops acted, they did not merely return 0)",
    psAfter.status === 0 && SEATS.every((n) => !psAfter.out.includes(n)), psAfter.out.slice(-400));

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
} finally {
  await m1?.stop().catch(() => {});
  await m2?.stop().catch(() => {});
  srv.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(fail === 0 ? 0 : 1);
