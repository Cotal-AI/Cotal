/**
 * THE CLASS-QUEUE SPLIT, RENDERED FROM A REAL ONE.
 *
 * `smoke:ep-rail-failure` grades every branch of {@link epRailFailure}, and drives three of its four
 * producer shapes against a real broker. The fourth — the describe-bound split, the one failure only
 * a LIVE manager can produce — is graded there on a hand-built `EpEnvelopeError`. That proves the
 * renderer's logic and nothing about the wire: an error assembled in the test is the test's own
 * belief about what core throws. This closes that gap and only that gap. Nothing here re-grades a
 * branch that suite already covers.
 *
 * THE ERROR IS REAL, AND FORCED RATHER THAN RACED. It comes out of the production `invokeCommand`
 * path, against a manager started by `cotal up` on a live broker. Determinism comes from pointing
 * the resolved handle's cached responder id at an instance that does not exist, so whichever
 * instance answers is not the bound incarnation on every run. Waiting for a natural split would
 * grade the same code on a coin flip, and `smoke:queue-win` measured class-queue delivery as sticky
 * on one box — that coin is loaded against the split ever appearing here.
 *
 * Open mode (no creds); sandboxes COTAL_HOME + a temp root; tears down with `cotal down`, never
 * pkill. Needs `nats-server` on PATH. Run: pnpm smoke:split-verdict:live
 */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  BASELINE_LIFECYCLE_ENDPOINT, DEV_OWNER, EpEnvelopeError, invokeCommand, mintLifecycleUid,
  newIdentity, resolveService, respondedButUnbound, standaloneConnectOpts, type EpCaller,
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
const EXPECTED_CELLS = 13;
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
    // could be any failure at all — a bad caller triple, a manager that never came up — and the
    // renderer would be graded on the wrong error while every cell stayed green.
    console.log("\n2. a REAL describe-bound split off the production invoke path");
    const control = await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000 });
    ok("an ordinary invoke against this handle SUCCEEDS", control.reply.ok === true, control.reply);

    const answeredBy = service.responder.instanceId;
    const ghost = `${"q".repeat(4)}${answeredBy.slice(4)}`;
    ok("the forced id is well-formed and is not the live instance",
      /^[a-z0-9]{26,32}$/.test(ghost) && ghost !== answeredBy, { ghost, answeredBy });
    service.responder.instanceId = ghost;

    let threw: unknown;
    try { await invokeCommand(nc, SPACE, service, "ps", undefined, { deadlineMs: 10_000 }); }
    catch (e) { threw = e; }
    ok("the same invoke now throws failed-precondition",
      threw instanceof EpEnvelopeError && threw.code === "failed-precondition",
      threw instanceof Error ? threw.message.slice(0, 160) : threw);
    ok("...carrying the responder-answered marker — the wire really does produce it here",
      respondedButUnbound(threw), threw instanceof Error ? threw.message.slice(0, 200) : threw);

    // ---- 3. WHAT THE RENDERER MAKES OF IT --------------------------------------------------
    // The claim, on the live error rather than a constructed one. A split is an ANSWER, so no
    // reachability verdict may be stated and `unanswered` must be false: a caller that keys on that
    // flag (`up`'s resume poll) must not read a split as silence.
    console.log("\n3. THE CLAIM — a live split renders as an answer, not as silence");
    const split = epRailFailure(threw, {});
    ok("no reachability verdict is stated", !VERDICT.test(split.error ?? ""), split);
    ok("...and it is not marked unanswered", split.unanswered === false, split);
    ok("...the responder's own account is what is printed",
      split.error?.startsWith("failed-precondition:") === true && split.error.includes(answeredBy), split);
    // The remedy is offered on the caller's declaration, not on the shape of the error — and a live
    // split is exactly where that distinction shows, since the error is identical either way.
    ok("...a caller that HAS --on and did not pass it is offered it",
      /--on <instance>/.test(split.error ?? ""), split);
    const noFlag = epRailFailure(threw);
    ok("...a caller with no such flag is not told to type one",
      !/--on/.test(noFlag.error ?? "") && noFlag.error === `failed-precondition: ${(threw as EpEnvelopeError).message}`, noFlag);
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
