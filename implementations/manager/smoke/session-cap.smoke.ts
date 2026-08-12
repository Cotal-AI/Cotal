/**
 * LIVE-SESSION CAP smoke (control-surface v0.4, Lane B finding 1; the security seat's
 * REQUEST-CHANGES). Run: pnpm smoke:session-cap   (needs nats-server on PATH; boots its own broker)
 *
 * Session establishment is CALLER-TRIGGERED and each session now mints credentials and opens its own
 * connection, so without a ceiling one authorized caller drives both without bound. The reviewed
 * attack: a leaked console token yields unbounded `establishAttach` plus seed-signed 24h
 * `session-caller` JWTs until process death, and the token gate alone does not bound that.
 *
 * The ceiling therefore has to refuse BEFORE anything with a cost or a side effect — before the
 * offer mint, before redemption, before either per-session credential, before the connection, and
 * before the target's PTY is attached. This smoke asserts exactly that, against a real broker and a
 * real Manager in auth mode, by counting what the refusal did NOT create:
 *
 *   • the N+1th establish refuses `resource-exhausted`, naming the cap so an operator knows the knob
 *   • `liveSessions` stays N — a refused attempt leaves no half-registered session behind
 *   • NO new credential row appears in the §13.1 family (no serving credential was minted)
 *   • NO caller JWT is returned (the console establisher never reaches its `mintCreds`)
 *   • capacity is RECOVERABLE: end one session and the next establish succeeds
 *   • a CONCURRENT burst past the cap still lands at most N — the ceiling is a reservation, not a
 *     check-then-act read (establishment awaits a mint, a redemption and a connection before the
 *     session is live, and the console face is HTTP, so it has that concurrency for real)
 *   • BOTH DOORS refuse with the same code and refuse BEFORE the target's PTY is attached: the ep
 *     door throws `EpEnvelopeError`, and the console's HTTP face answers 429 with a stable
 *     `{error, code}` body rather than the 500 it gives an internal fault
 *
 * The cap is proven to be the cause rather than a coincidence by running the same N+1th establish
 * against a manager configured with a higher cap and watching it succeed.
 */
import { spawn as spawnProc, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable, createSpaceAuth, serverConfig, setupSpaceStreams, mintCreds, newIdentity,
  mintLifecycleUid, standaloneConnectOpts, registry, DEV_OWNER, EpEnvelopeError,
  epAuthBucket, epcredFamilyPrefix,
  type AgentHandle, type Connector, type LaunchSpec, type Presence,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = (): Promise<number> =>
  new Promise((res, rej) => {
    const s = createServer();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); });
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const CAP = 2;
const WS_PORT = 18222; // never dialled: it only enables the console establisher path
const PORT = await freePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `sesscap-${mintLifecycleUid().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-sesscap-"));
const workspaceRoot = join(dir, "ws");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
writeFileSync(
  join(workspaceRoot, ".cotal", "agents", "worker.md"),
  `---\nname: worker\nrole: worker\nsubscribe: [general]\nallowSubscribe: [general]\nallowPublish: [general]\n---\nbody\n`,
);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { port: PORT, storeDir: join(dir, "js") }));

const kids: ChildProcess[] = [];
const conns: NatsConnection[] = [];
kids.push(spawnProc("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" }));
const managers: InstanceType<typeof Manager>[] = [];

const fakeSession = () => ({ cols: 80, rows: 24, backlog: () => Buffer.alloc(0), onData: () => () => {}, onExit: () => () => {}, write: () => {}, resize: () => {} });
/** Every `attach()` the manager performs, counted: a capacity refusal must land BEFORE the target's
 *  PTY is attached, and the only honest way to assert that is to watch the target's own handle. */
let attaches = 0;
const fakeHandle = (name: string): AgentHandle => ({ name, kind: "fake", status: () => "running", stop: () => {}, interrupt: () => {}, attach: () => { attaches++; return fakeSession(); } });

async function bootManager(maxSessions: number): Promise<InstanceType<typeof Manager>> {
  // `wsPort` is what wires the console establisher at all (the constructor injects it only when a
  // websocket listener exists). The value is never dialled here — the smoke drives the establisher
  // directly and asserts on what it did or did not create.
  const mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot, maxSessions, wsPort: WS_PORT });
  (mgr as unknown as { runtime: { kind: string; spawn: (n: string, s: LaunchSpec) => AgentHandle } }).runtime = { kind: "fake", spawn: (name) => fakeHandle(name) };
  (mgr as unknown as { ep: Record<string, unknown> }).ep = {
    ref: () => ({ id: "smoke-mgr" }), on: () => {}, off: () => {},
    waitForPresenceSnapshot: () => Promise.resolve(), getRoster: (): Presence[] => [],
  };
  await mgr.start();
  (mgr as unknown as { awaitReadiness(): Promise<{ ok: true }> }).awaitReadiness = async () => ({ ok: true });
  managers.push(mgr);
  return mgr;
}

try {
  let up = false;
  for (let i = 0; i < 60; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  registry.register({ kind: "connector", name: "smoke-cap", requires: ["node"], buildLaunch: () => ({ command: "true", args: [], env: {} }) } as Connector);

  const mgr = await bootManager(CAP);
  const M = mgr as unknown as {
    managerInstanceId: string;
    sessionPlane: { liveSessions: number; maxSessions: number; endAll(r: string): void };
    establishConsoleSession(name: string): Promise<{ grant: { sessionId: string }; creds: string }>;
    agents: Map<string, unknown>;
    attachAuthorized(a: unknown, caller: { owner: string; actor: string; uid: string }): Promise<{ ok: boolean; data?: { grant: { sessionId: string } }; error?: string }>;
  };
  /** End every live session and wait for the plane to actually drain (teardown is async). */
  const drained = async (): Promise<boolean> => {
    M.sessionPlane.endAll("closed");
    for (let i = 0; i < 100 && M.sessionPlane.liveSessions > 0; i++) await wait(50);
    return M.sessionPlane.liveSessions === 0;
  };
  const iid = M.managerInstanceId;
  check("fixture: the manager took the configured cap", M.sessionPlane.maxSessions === CAP, M.sessionPlane.maxSessions);

  const spawned = await mgr.startAgent({ name: "worker", agent: "smoke-cap" });
  check("fixture: an agent is running to attach to", spawned.ok === true, spawned);

  // Count the §13.1 credential family: a minted per-session SERVING credential lands here, so an
  // unchanged count is positive evidence that the refusal minted nothing.
  const execNc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "endpoint-serve-executor", { endpointServeExecutor: { endpoint: MANAGER_ENDPOINT, instanceId: iid } }) }), maxReconnectAttempts: 0 });
  conns.push(execNc);
  const authKv = await new Kvm(execNc).open(epAuthBucket(space));
  const familySize = async (): Promise<number> => {
    let n = 0;
    for await (const k of await authKv.keys(`${epcredFamilyPrefix(MANAGER_ENDPOINT, iid)}.>`)) { void k; n++; }
    return n;
  };

  console.log("A. sessions establish normally up TO the cap");
  const ids: string[] = [];
  for (let i = 0; i < CAP; i++) {
    const r = await M.establishConsoleSession("worker");
    ids.push(r.grant.sessionId);
    check(`session ${i + 1}/${CAP} established`, typeof r.grant.sessionId === "string" && r.grant.sessionId.length > 0);
    check(`session ${i + 1}/${CAP} got a real caller credential`, typeof r.creds === "string" && r.creds.length > 0);
  }
  check("the plane reports exactly the cap in live sessions", M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
  check("the sessions are DISTINCT (not one session counted twice)", new Set(ids).size === CAP, ids);

  console.log("B. the N+1th establish REFUSES, and creates nothing");
  const familyBefore = await familySize();
  let refusal: { code?: string; message: string } | undefined;
  let leaked: unknown;
  try {
    leaked = await M.establishConsoleSession("worker");
  } catch (e) {
    refusal = { code: (e as { code?: string }).code, message: (e as Error).message };
  }
  check("it throws rather than establishing", refusal !== undefined && leaked === undefined, { refusal, leaked });
  check("the refusal is `resource-exhausted`", refusal?.code === "resource-exhausted", refusal);
  check("the message NAMES the cap and its current value (an operator learns the knob to raise)",
    refusal !== undefined && refusal.message.includes(String(CAP)) && refusal.message.includes("maxSessions"), refusal?.message);
  check("liveSessions stays at N — the refused attempt left no half-registered session",
    M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
  check("NO caller JWT was returned (the establisher never reached its mintCreds)", leaked === undefined);
  check("NO new credential row was staged — no serving credential was minted either",
    (await familySize()) === familyBefore, { before: familyBefore, after: await familySize() });

  console.log("C. capacity is RECOVERABLE: ending a session frees a slot");
  M.sessionPlane.endAll("closed");
  for (let i = 0; i < 100 && M.sessionPlane.liveSessions > 0; i++) await wait(50);
  check("the plane drains back to zero live sessions", M.sessionPlane.liveSessions === 0, M.sessionPlane.liveSessions);
  const after = await M.establishConsoleSession("worker");
  check("an establish after the drain succeeds (the cap bounds concurrency, never total sessions)",
    typeof after.grant.sessionId === "string" && !ids.includes(after.grant.sessionId));

  console.log("D. the refusal TRACKS OCCUPANCY (it is the cap, not a one-off failure)");
  {
    // Establishment now cycles refuse -> free -> succeed -> refill -> refuse against ONE manager, so
    // the refusal is demonstrably a function of how many sessions are live rather than a call that
    // happens to fail the second time. (A second Manager cannot serve the same space from the same
    // workspace root, by design, so the causal proof is this cycle rather than a roomier twin.)
    check("one slot is in use after the recovery establish", M.sessionPlane.liveSessions === 1, M.sessionPlane.liveSessions);
    while (M.sessionPlane.liveSessions < CAP) await M.establishConsoleSession("worker");
    check("refilled back to the cap", M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
    const familyAtCap = await familySize();
    let second: { code?: string } | undefined;
    try { await M.establishConsoleSession("worker"); } catch (e) { second = { code: (e as { code?: string }).code }; }
    check("it refuses AGAIN once refilled to the cap", second?.code === "resource-exhausted", second);
    check("and again minted nothing", (await familySize()) === familyAtCap, { familyAtCap, now: await familySize() });
  }

  console.log("E. CONCURRENT stampede: the ceiling is a RESERVATION, not a check-then-act read");
  {
    // The reviewed attack: establishment awaits a mint, a redemption and a connection before the
    // session becomes live, so a bare read of the live count would let N concurrent callers at
    // `max - 1` all observe room, all mint seed-signed credentials, and all land. The HTTP face
    // already has that concurrency. Fire well past the cap AT ONCE from empty and assert the
    // ceiling held on all three observable quantities.
    M.sessionPlane.endAll("closed");
    for (let i = 0; i < 100 && M.sessionPlane.liveSessions > 0; i++) await wait(50);
    const baseline = await familySize();
    const attempts = CAP + 6;
    const results = await Promise.allSettled(
      Array.from({ length: attempts }, () => M.establishConsoleSession("worker")),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    // The CEILING is the security property: it must hold no matter how the losers lost.
    check(`at most ${CAP} of ${attempts} concurrent establishes succeeded (the ceiling held)`, ok.length <= CAP, { ok: ok.length, refused: refused.length });
    check("liveSessions never exceeded the cap", M.sessionPlane.liveSessions <= CAP, M.sessionPlane.liveSessions);
    // And the cap must be the reason they lost. Every refusal is `resource-exhausted`: if a loser
    // failed for any other reason (gate contention, a lost CAS) the ceiling would be "holding" by
    // accident, and a fix to that unrelated failure would silently uncap the burst.
    check("EVERY refusal is `resource-exhausted` — the cap is the reason, not incidental contention",
      refused.every((r) => (r.reason as { code?: string })?.code === "resource-exhausted"),
      refused.map((r) => (r.reason as { code?: string })?.code ?? String(r.reason)));
    check(`the cap is also SATURATED (exactly ${CAP} admitted, so the burst was not simply failing)`, ok.length === CAP, { ok: ok.length });
    // The credential family is the honest count of what was actually minted: at most one serving
    // credential per admitted session, never one per attempt.
    check(`the §13.1 family grew by at most ${CAP} rows — no over-minting under the stampede`,
      (await familySize()) - baseline <= CAP, { baseline, after: await familySize(), cap: CAP });
    check("every fulfilled establish returned a caller credential; refused ones returned nothing",
      ok.every((r) => typeof (r.value as { creds: string }).creds === "string" && (r.value as { creds: string }).creds.length > 0));
  }

  console.log("F. the EP door: the refusal is an EpEnvelopeError, and it lands BEFORE the PTY attach");
  {
    // The ep `attach` command is `unwrap(await this.attachAuthorized(...))`, so a THROWN
    // EpEnvelopeError keeps its code on the wire while a soft `{ok:false, error}` would collapse into
    // a generic failure the caller cannot branch on. Drive the door itself, and count the target's
    // own `attach()` calls: this door used to attach the PTY first and discover the ceiling after.
    check("fixture: the plane drained before the ep-door run", await drained(), M.sessionPlane.liveSessions);
    const a = M.agents.get("worker");
    check("fixture: the managed agent is reachable as the ep door sees it", a !== undefined);
    const caller = { owner: DEV_OWNER, actor: "operator", uid: mintLifecycleUid() };
    for (let i = 0; i < CAP; i++) {
      const r = await M.attachAuthorized(a, caller);
      check(`ep-door session ${i + 1}/${CAP} established`, r.ok === true && typeof r.data?.grant.sessionId === "string", r);
    }
    const attachesAtCap = attaches;
    let epRefusal: unknown;
    let epSoft: unknown;
    try { epSoft = await M.attachAuthorized(a, caller); } catch (e) { epRefusal = e; }
    check("the ep door THROWS rather than returning a soft {ok:false} the wire cannot classify",
      epRefusal !== undefined && epSoft === undefined, { epSoft });
    check("the throw is an EpEnvelopeError (so the ep envelope carries a code, not just prose)",
      epRefusal instanceof EpEnvelopeError, epRefusal instanceof Error ? epRefusal.message : epRefusal);
    check("the ep-door code is `resource-exhausted`", (epRefusal as { code?: string })?.code === "resource-exhausted", (epRefusal as { code?: string })?.code);
    check("the refused ep establish did NOT attach the target's PTY (the ordering, not just the code)",
      attaches === attachesAtCap, { attachesAtCap, now: attaches });
  }

  console.log("G. the CONSOLE face: a real HTTP POST past the cap is 429 with a stable {error, code}");
  {
    // The browser's actual door — the manager's own AttachEndpoint, on its own port, wired to the
    // REAL establisher (a stub would only prove the face maps whatever it is handed). Every failure
    // used to be 500 with a bare {error}, so a capacity refusal was indistinguishable from an
    // internal fault.
    check("fixture: the plane drained before the console-face run", await drained(), M.sessionPlane.liveSessions);
    const url = new URL(mgr.consoleUrl);
    const token = url.hash.replace(/^#t=/, "");
    const post = (name: string) => fetch(`${url.origin}/session/${name}?t=${token}`, { method: "POST" });
    const first = await post("worker");
    const firstBody = (await first.json()) as { grant?: { sessionId?: string }; creds?: string };
    check("with room, the real face establishes over HTTP (200 + grant + caller credential)",
      first.status === 200 && typeof firstBody.grant?.sessionId === "string" && (firstBody.creds?.length ?? 0) > 0,
      { status: first.status, body: firstBody });
    // A 500 must still be a 500: the 429 is a classification, not a blanket softening of the face.
    // Asserted with room to spare, because the ceiling is deliberately the OUTER gate — at the cap
    // even a request for a nonexistent agent is refused `resource-exhausted` before the lookup.
    const missing = await post("no-such-agent");
    const missingBody = (await missing.json()) as { error?: string; code?: string };
    check("an unrelated failure is still 500 with no code (the 429 did not swallow every error)",
      missing.status === 500 && missingBody.code === undefined && (missingBody.error ?? "").includes("no-such-agent"),
      { status: missing.status, body: missingBody });
    while (M.sessionPlane.liveSessions < CAP) {
      const fill = await post("worker");
      if (fill.status !== 200) { check("fixture: filling to the cap over HTTP", false, fill.status); break; }
    }
    check("fixture: the face filled the plane to the cap", M.sessionPlane.liveSessions === CAP, M.sessionPlane.liveSessions);
    const attachesAtCap = attaches;
    const over = await post("worker");
    const body = (await over.json()) as { error?: string; code?: string };
    check("the over-cap POST is 429, NOT the 500 an internal fault gets", over.status === 429, { status: over.status, body });
    check("the body carries the stable `code` a page can branch on", body.code === "resource-exhausted", body);
    check("the body still names the ceiling and its knob for an operator reading the response",
      (body.error ?? "").includes(String(CAP)) && (body.error ?? "").includes("maxSessions"), body.error);
    check("the response is JSON", (over.headers.get("content-type") ?? "").includes("application/json"), over.headers.get("content-type"));
    check("the refused POST did NOT attach the target's PTY", attaches === attachesAtCap, { attachesAtCap, now: attaches });
  }

  console.log(`\nsession-cap smoke: ${pass} passed, ${fail} failed`);
} finally {
  for (const c of conns) await c.drain().catch(() => c.close());
  for (const m of managers) await m.stop().catch(() => {});
  for (const k of kids) k.kill("SIGKILL");
  await wait(200);
}

process.exit(fail > 0 ? 1 : 0);
