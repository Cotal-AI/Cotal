/**
 * ITEM 0 — the preflight-OK path, where a false satisfaction would be INVISIBLE.
 *
 * The broker-less cell (`status-delivery-row.smoke.ts`) drives the preflight-FAILURE path, because
 * that is what a machine with no broker can reach. It is not the path that matters. On the OK path
 * the `connection` row renders green `ok` and the delivery line is built from BROKER ERROR STRINGS
 * this lane does not author — so if such a string ever places "connection" before "unreachable" on
 * one line, `up-tls-routes-live`'s whole-output security assertion is satisfied while the connection
 * row says ok, with no legitimate emitter supplying the same match.
 *
 * THE INVARIANT (stronger than "the delivery row does not match"):
 *
 *     every line of `cotal status`'s output matching /connection\s+.*unreachable/
 *     must be a line whose LABEL is `connection`
 *
 * An invariant rather than an exclusion, so it holds for rows added later by lanes that will never
 * read this file. The evidence for a whole-output assertion must come from the emitter that
 * assertion is about.
 *
 * ═══ PATH WITNESSES RUN FIRST, AND THE INVARIANT IS WORTHLESS WITHOUT THEM ═══
 *
 * A cell that substitutes a broker to reach a path proves nothing if the substitution does not take:
 * the assertions simply pass over the WRONG path, and a pass is the outcome nobody investigates.
 * COMPILED IS NOT EXECUTED; STARTED IS NOT REACHED. So before asserting anything, this cell proves
 * the output came from the path it claims to be driving, using strings only that path can emit:
 *
 *   W1  a `connection` row whose value is `ok`   — printed ONLY on the preflight-OK branch
 *   W2  the delivery row does NOT say "preflight failed" — that phrasing is the static template on
 *       the FAILURE branch, so its absence rules out the branch this cell must not be on
 *   W3  the delivery row carries `[observed Nms ago]` and `CANNOT ESTABLISH HEALTH` — produced by
 *       `renderGuard`/`renderHealth`, reachable only THROUGH the health assessment, which is what
 *       proves `deliveryStatusRow` → `mintDeliveryCaller` → `deliveryRow` actually ran
 *
 * W3 is the one that matters: W1 proves preflight passed, but only W3 proves the assessment ran
 * rather than some other branch printing a plausible line. Each witness is a string emitted by the
 * CODE UNDER TEST on the branch in question — not a message this harness prints about itself, which
 * would be checking the messenger.
 *
 * Run: pnpm exec tsx implementations/cli/smoke/status-delivery-ok-live.smoke.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable } from "@cotal-ai/core";
import { findCotalRoot, recordMesh } from "@cotal-ai/workspace";
import { status } from "../src/commands/status.js";
import { evidenceComesOnlyFrom, mustNotSay, nothingMatches, rowLabel, stripAnsi } from "./_output-invariant.js";
import { pickFreePort } from "../../delivery/smoke/_free-port.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${detail === undefined ? "" : ` — ${String(detail)}`}`); }
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;

// ---- FIRST ACTION, before anything connects: this is not the live broker.
if (SERVERS.includes("broker.cotal.ai") || !/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) {
  console.error(`REFUSING: broker URL is not an ephemeral loopback: ${SERVERS}`);
  process.exit(2);
}
console.log(`\nstatus-delivery-ok-live — preflight-OK path against ${SERVERS}\n`);
check("FIRST ACTION: the broker is ephemeral loopback, not the live host", !SERVERS.includes("broker.cotal.ai"));

const dir = mkdtempSync(join(tmpdir(), "fmh-okpath-"));
const anchored = join(dir, "anchored");
const bare = join(dir, "bare");
mkdirSync(anchored, { recursive: true });
mkdirSync(bare, { recursive: true });
mkdirSync(join(anchored, ".cotal"), { recursive: true });
writeFileSync(join(anchored, ".cotal", "space"), "okpath\n");

check("the .cotal anchor resolves to the anchored dir", findCotalRoot(anchored) === anchored);
check("NEGATIVE CONTROL: an unanchored sibling does NOT resolve to the anchored root",
  findCotalRoot(bare) !== anchored);

// PIDS RECORDED AT CREATION. Only these are ever killed, and the scratch is deleted only after the
// child's exit has been OBSERVED — never on a timer.
const created: { srv?: number } = {};
let srv: ChildProcess | undefined;
const reap = (why: string): void => {
  console.error(`\n  ✗ FATAL (${why}) — reaping pids recorded at creation`);
  if (created.srv) { try { process.kill(created.srv, "SIGKILL"); } catch { /* gone */ } }
  console.error(`  scratch left for inspection: ${dir}`);
};
process.once("uncaughtException", (e) => { reap(`uncaughtException: ${e.message}`); process.exit(1); });
process.once("unhandledRejection", (e) => { reap(`unhandledRejection: ${String(e)}`); process.exit(1); });

const lines: string[] = [];
let srvExit: number | string = "NOT-OBSERVED";

try {
  // An OPEN broker: no auth material, because this cell is about the RENDERING path and an open mesh
  // reaches it with the fewest moving parts. The delivery lease bucket does not exist here, so the
  // assessment returns a real named refusal — which is exactly the "text this lane does not author"
  // the invariant needs to be tested against.
  writeFileSync(join(dir, "server.conf"), `port: ${PORT}\njetstream { store_dir: "${join(dir, "js")}" }\n`);
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  created.srv = srv.pid;
  const exited = new Promise<number | string>((r) => srv?.once("exit", (code, sig) => r(code ?? sig ?? "UNKNOWN")));

  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  check("the ephemeral broker came up (a cell that cannot start its subject must refuse, not pass)", up);
  if (!up) throw new Error(`ephemeral nats-server did not come up on ${PORT}`);

  process.env.COTAL_HOME = join(dir, "home");
  mkdirSync(process.env.COTAL_HOME, { recursive: true });
  recordMesh({ space: "okpath", server: SERVERS, root: anchored, mode: "open" });

  const realLog = console.log;
  const prevCwd = process.cwd();
  process.chdir(anchored);
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await status({ values: { server: SERVERS, space: "okpath" }, positionals: [] } as never);
  } finally {
    console.log = realLog;
    process.chdir(prevCwd);
  }

  const plain = lines.map(stripAnsi);
  const deliveryLine = plain.find((l) => rowLabel(l) === "delivery") ?? "";
  const connLine = plain.find((l) => rowLabel(l) === "connection") ?? "";
  const deliveryValue = deliveryLine.replace(/^\s*delivery\s*/, "").trim();

  // ═══ PATH WITNESSES ═══
  console.log("\n  — path witnesses (the invariant below means nothing without these) —");
  const w1 = /^\s*connection\s+ok\b/.test(connLine);
  check("W1: a `connection ok` row is present — printed ONLY on the preflight-OK branch", w1, connLine || "(no connection row)");
  const w2 = mustNotSay(deliveryValue, /preflight failed/i);
  check("W2: the delivery row is NOT the failure-branch template", w2.ok, w2.ok ? "" : w2.detail);
  const w3 = /\[observed \d+ms ago\]/.test(deliveryValue) && /CANNOT ESTABLISH HEALTH|serving/i.test(deliveryValue);
  check("W3: the delivery row came THROUGH the health assessment (renderGuard age prefix + verdict)",
    w3, deliveryValue || "(no delivery row)");
  const onPath = w1 && w2.ok && w3;
  if (!onPath) {
    fail++;
    console.log("  ✗ FAIL: PATH NOT ESTABLISHED — the invariant assertions below are NOT evidence about the preflight-OK path");
  }

  console.log("\n  — the invariant —");
  const CONN_RX = /connection\s+.*unreachable/;
  const verdict = evidenceComesOnlyFrom(plain, CONN_RX, "connection");
  // On this path the connection row says `ok`, so NOTHING should match the unreachable pattern. That
  // makes `no-match` the EXPECTED outcome here — and it is reported as a refusal by design, so it is
  // asserted as such rather than being allowed to masquerade as a conforming pass.
  check("INVARIANT: no line matches the unreachable pattern on a healthy connection, and that is reported as `no-match` rather than as a pass",
    verdict.kind === "no-match", verdict.kind);
  check("…and NO non-`connection` row supplies that match (the real property, stated positively)",
    verdict.kind !== "violated", verdict.kind === "violated" ? verdict.offenders.join(" | ") : "");
  const twin = nothingMatches(plain.filter((l) => rowLabel(l) !== "connection"), /connection\s+ok/);
  check("NEGATIVE TWIN: no NON-connection row emits `connection ok` either", twin.ok, twin.offenders.join(" | "));
  check("the delivery row itself does not satisfy the security regex", !CONN_RX.test(deliveryValue), deliveryValue);
  check("the delivery row is non-empty — the #445 empty rendering, on the path that can actually produce text",
    deliveryValue.length > 0, JSON.stringify(deliveryValue));

  console.log(`\n  delivery row as rendered: ${JSON.stringify(deliveryValue)}`);
  console.log(`  connection row as rendered: ${JSON.stringify(connLine.trim())}`);
} finally {
  if (created.srv) { try { process.kill(created.srv, "SIGKILL"); } catch { /* gone */ } }
  if (srv) {
    srvExit = await Promise.race([
      new Promise<number | string>((r) => srv?.once("exit", (c, s) => r(c ?? s ?? "UNKNOWN"))),
      (async () => { await wait(5_000); return "TIMED-OUT"; })(),
    ]);
  }
  // The scratch is deleted only if the child's exit was OBSERVED. Deleting a live child's store dir
  // is how a broker ends up writing into a path that no longer exists.
  if (srvExit !== "TIMED-OUT" && srvExit !== "NOT-OBSERVED") rmSync(dir, { recursive: true, force: true });
  else console.log(`  scratch KEPT (broker exit not observed: ${String(srvExit)}): ${dir}`);
}

check("the broker's exit was OBSERVED, not assumed", srvExit !== "TIMED-OUT" && srvExit !== "NOT-OBSERVED", srvExit);

console.log(
  fail === 0
    ? `\nSTATUS-DELIVERY-OK-LIVE OK ✅  (${pass} passed, ${fail} failed)\n`
    : `\nSTATUS-DELIVERY-OK-LIVE FAILED ❌  (${pass} passed, ${fail} failed)\n`,
);
if (fail > 0) process.exitCode = 1;
if (pass === 0) { console.log("REFUSING: no cell ran"); process.exitCode = 2; }
