/**
 * THE CLASS-QUEUE SPLIT, AGAINST A REAL MANAGER — AND WHAT THE FENCE MAKES OF IT.
 *
 * The production `invokeCommand` path carries the incarnation the caller resolved (`bind`, §13.3),
 * so a manager that is not that incarnation refuses BEFORE running the command. This drives that
 * against a manager started by `cotal up` on a live broker and grades the one claim no unit fixture
 * can make for the CLI: that the path an operator actually rides now returns a refusal PROVING
 * nothing ran, where it used to raise a report that could not say either way.
 *
 * WHAT CHANGED HERE. This file used to assert the opposite outcome — that the same doctored invoke
 * THREW `failed-precondition` carrying `EP_UNBOUND_RESPONDER`, and that the CLI rendered that throw
 * as an answer rather than as silence. That was the best available before the fence: the split was
 * detected on the reply, so the throw was all there was. It is now a reply, and the assertions
 * below are the same experiment graded against the stronger result.
 *
 * FORCED, NOT RACED. Determinism comes from pointing the resolved handle's cached responder id at
 * an instance that does not exist, so whichever manager answers is not the bound incarnation on
 * every run. Waiting for a natural split would grade the same code on a coin flip, and
 * `smoke:queue-win` measured class-queue delivery as sticky on one box.
 *
 * WHAT THIS DOES NOT PROVE. A responder that does not know the `bind` field ignores it (§5) and
 * runs the command, and the caller is back to the after-the-fact report — so `epRailFailure`'s
 * split branch stays live for version skew and stays graded in `smoke:ep-rail-failure`, on a
 * constructed error, because a current manager can no longer produce one. The `--on` remedy line
 * is likewise unreachable from a current CLI against a current manager; both are kept for the
 * skewed pair, not as dead code.
 *
 * Open mode (no creds); sandboxes COTAL_HOME + a temp root; tears down with `cotal down`, never
 * pkill. Needs `nats-server` on PATH. Run: pnpm smoke:bind-fence:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  BASELINE_LIFECYCLE_ENDPOINT, DEV_OWNER, EpEnvelopeError, invokeCommand, mintLifecycleUid,
  newIdentity, resolveService, replyRefusedBeforeEffect, standaloneConnectOpts, type EpCaller,
  type EndpointReply,
} from "@cotal-ai/core";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { epRailFailure } from "../src/lib/control.js";

// EPHEMERAL, not a fixed port distinct from the other live smokes'. A fixed port is only safe while
// no two live smokes share a runner, which is a property of how smoke:ci is sharded rather than of
// anything this file controls -- so it is a hazard to be managed, at a distance, by whoever next
// changes the sharding. Picking a free port removes it instead.
const PORT = await pickFreePort();
const SERVER = `nats://127.0.0.1:${PORT}`;
const SPACE = "split-verdict";
const WT = resolve(import.meta.dirname, "..", "..", "..");
const CLI = join(WT, "bin", "cotal.ts");
const TSX = join(WT, "node_modules", ".bin", "tsx");
const VERDICT = /no manager reachable|did not answer/;

const home = mkdtempSync(join(tmpdir(), "cotal-split-home-"));
const root = mkdtempSync(join(tmpdir(), "cotal-split-root-"));
const env = { ...process.env, COTAL_HOME: home };

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** How many cells this file must run. A live suite can end early in ways that redden NO line — a
 *  guard that returns before the fixture is up, a hang the runner kills, a top-level rejection that
 *  tears the process down before the summary — and `fail === 0` reads as PASS in every one of them,
 *  with a zero exit code, which is the only bit anyone downstream looks at. So the count is declared
 *  rather than implied, and checked on the way out however the process leaves. */
const EXPECTED_CELLS = 14;
process.on("exit", () => {
  const ran = pass + fail;
  if (ran !== EXPECTED_CELLS) {
    console.log(`\nSUITE INCOMPLETE — ran ${ran} of ${EXPECTED_CELLS} cells; a partial run is not a pass`);
    process.exitCode = 1;
  }
});
const cli = (...args: string[]) => spawnSync(TSX, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port: number) =>
  new Promise<boolean>((res) => {
    const s = createConnection({ host: "127.0.0.1", port }, () => { s.destroy(); res(true); });
    s.on("error", () => res(false));
    s.setTimeout(400, () => { s.destroy(); res(false); });
  });

writeFileSync(join(root, "base.yaml"), `apiVersion: cotal/v1
kind: Mesh
space: ${SPACE}
agent: claude
broker: { servers: "${SERVER}", auth: false }
channels:
  lobby: { description: "base" }
`);

try {
  // ---- 1. A LIVE MANAGER --------------------------------------------------------------------
  console.log("\n1. a live manager on a live broker");
  const up = cli("up", "-f", join(root, "base.yaml"), "--server", SERVER);
  ok("mesh up", new RegExp(`mesh "${SPACE}" up`).test(up.stdout), up.stdout + up.stderr);
  await sleep(2000);
  ok("broker bound", await portOpen(PORT));
  // SERVING, not merely started: `up` returns once the supervisor is launched, and everything below
  // needs a responder on the rails. Polled through the binary, so readiness means what an operator
  // would call ready.
  let serving = false;
  for (let i = 0; i < 20 && !serving; i++) {
    if (cli("ps", "--space", SPACE).status === 0) serving = true;
    else await sleep(1000);
  }
  ok("the manager answers control", serving);

  // The OPEN-mesh caller triple `askManager` synthesizes for itself: no credential system, the
  // manager registered under DEV_OWNER, the broker enforces nothing.
  const caller: EpCaller = { owner: DEV_OWNER, actor: newIdentity().id, uid: mintLifecycleUid() };
  const nc = await connect({ servers: SERVER, ...standaloneConnectOpts({ tls: false }), maxReconnectAttempts: 0 });
  try {
    const service = await resolveService(nc, SPACE, BASELINE_LIFECYCLE_ENDPOINT, caller, { deadlineMs: 10_000 });
    ok("the caller resolves the manager service", service.commands.has("ps"), [...service.commands.keys()].sort());

    // ---- 2. THE SPLIT, FORCED -------------------------------------------------------------
    // The control: an UNDOCTORED invoke must succeed first. Without it the doctored failure below
    // could be any failure at all — a bad caller triple, a manager that never came up — and every
    // cell would stay green while grading the wrong thing. It is also the twin that makes "did not
    // run" mean something: the SAME command, on the SAME manager, does run when the bind fits.
    console.log("\n2. a REAL bind mismatch off the production invoke path");
    const control = await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000 });
    ok("an ordinary invoke against this handle SUCCEEDS", control.reply.ok === true, control.reply);

    const answeredBy = service.responder.instanceId;
    const ghost = `${"q".repeat(4)}${answeredBy.slice(4)}`;
    ok("the forced id is well-formed and is not the live instance",
      /^[a-z0-9]{26,32}$/.test(ghost) && ghost !== answeredBy, { ghost, answeredBy });
    service.responder.instanceId = ghost;

    let threw: unknown;
    let refused: EndpointReply | undefined;
    try { refused = (await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000 })).reply; }
    catch (e) { threw = e; }
    ok("the same invoke does NOT throw — the manager answered it",
      threw === undefined, threw instanceof Error ? threw.message.slice(0, 200) : threw);
    ok("...it comes back ok:false failed-precondition",
      refused?.ok === false && refused.error?.code === "failed-precondition", refused);
    ok("...carrying the bind-refused marker — the wire really does produce it here",
      replyRefusedBeforeEffect(refused?.error), refused?.error);

    // ---- 3. WHAT THE OPERATOR IS TOLD ------------------------------------------------------
    // The claim, on the live refusal. `askManagerEp` renders a non-ok reply as its message, so the
    // message IS the operator-facing text — and the one thing it has to carry is that the command
    // did not run, because that is what makes re-issuing safe.
    console.log("\n3. THE CLAIM — a live bind mismatch says the command did not run");
    const msg = refused?.error?.message ?? "";
    ok("the account states the command was not run", /WAS NOT RUN/.test(msg), msg.slice(0, 200));
    ok("...and names the incarnation that refused, off its own identity", msg.includes(answeredBy), msg.slice(0, 200));
    ok("...and the one the caller had bound", msg.includes(ghost), msg.slice(0, 200));
    // No reachability verdict, from either side: a refusal is an ANSWER. `up`'s resume poll keys on
    // `unanswered`, and reading a refusal as silence is what turns a retry into a duplicate spawn.
    ok("no reachability verdict is stated", !VERDICT.test(msg), msg.slice(0, 200));
    const rendered = epRailFailure(new EpEnvelopeError("failed-precondition", msg), {});
    ok("...and the rail renderer does not mark it unanswered", rendered.unanswered === false, rendered);
  } finally {
    await nc.drain().catch(() => nc.close());
  }
} finally {
  // Always bare `cotal down`, never pkill — and it must run even when a cell above threw, or the
  // fixture leaks a broker on the fixed port and the NEXT run silently grades a stale mesh.
  cli("down");
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}

// `exitCode`, not `exit()`: the completeness handler above has to be able to override a zero, and
// an explicit exit here would also cut the fixture's teardown short.
console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
