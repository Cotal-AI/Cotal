/**
 * ACL registry CAS smoke — the commitAcl write discipline, verified against a real KV.
 *
 * Regression for the garbled-row wedge (found by live testing): a row whose bytes readAcl cannot
 * decode reads as `undefined` (DEFER, deliberately), which used to send every commitAcl for that
 * owner down the `create` path against an EXISTING key — five silent conflicts, then an opaque
 * "acl CAS exhausted retries" with the real error discarded. The owner stayed wedged until purge.
 * commitAcl now CAS-overwrites a present-but-garbled row at its raw revision, and the exhausted
 * throw carries the last underlying KV error.
 *
 * Run: pnpm smoke:acl-cas   (needs nats-server on PATH; part of smoke:ci)
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import type { KV } from "@nats-io/kv";
import { isReachable, openAclRegistry, readAcl, commitAcl, reissueAcl, deleteAcl, aclKey } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => {
  if (v) { ok++; } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ACL rows are lifecycle-keyed `<owner>.<actor>.<uid>` (SPEC §13.1) — one uid per simulated agent.
const U1 = "owner1aaaaaaaaaaaaaaaaaaaaa"; // 26 chars, [a-z0-9]
const UG = "garbledbbbbbbbbbbbbbbbbbbbb";
const UW = "wedgedcccccccccccccccccccc";

const PORT = await pickFreePort();
const sd = mkdtempSync(join(tmpdir(), "cotal-aclcas-"));
const broker = spawn("nats-server", ["-js", "-sd", sd, "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(`nats://127.0.0.1:${PORT}`); if (!up) await wait(100); }
  c("broker is reachable", up);
  const nc = await connect({ servers: `nats://127.0.0.1:${PORT}` });
  const kv = await openAclRegistry(nc, "aclcas", { create: true });

  // ── the ordinary paths still hold ──
  const created = await commitAcl(kv, "local.owner1", U1, ["general"]);
  c("fresh create", created.revision === 1 && (await readAcl(kv, "local.owner1", U1))?.record.allowSubscribe[0] === "general");
  const updated = await reissueAcl(kv, "local.owner1", U1, ["general", "review"]);
  c("update bumps revision", updated.revision === 2 && (await readAcl(kv, "local.owner1", U1))?.record.revision === 2);
  await deleteAcl(kv, "local.owner1", U1);
  c("delete purges", (await readAcl(kv, "local.owner1", U1)) === undefined);
  const recreated = await commitAcl(kv, "local.owner1", U1, ["general"]);
  c("recreate after purge", recreated.revision === 1);
  // Plain raise above the mint ceiling is refused — the ceiling is reissue-only.
  let raiseBlocked = false;
  try { await commitAcl(kv, "local.owner1", U1, ["general", "secret"]); }
  catch (e) { raiseBlocked = /cannot raise ACL above mint-time ceiling/i.test((e as Error).message); }
  c("plain commitAcl cannot raise above mint ceiling", raiseBlocked);
  const still = await readAcl(kv, "local.owner1", U1);
  c("refused raise left the row unchanged", !!still && still.record.allowSubscribe.length === 1 && still.record.allowSubscribe[0] === "general");

  // ── the garbled-row wedge (regression; red before the CAS-overwrite fix) ──
  await kv.put(aclKey("local.garbled", UG), new TextEncoder().encode("this-is-not-json"));
  c("garbled row reads as DEFER (undefined)", (await readAcl(kv, "local.garbled", UG)) === undefined);
  const healed = await commitAcl(kv, "local.garbled", UG, ["general"]);
  c("commitAcl OVERWRITES the garbled row instead of wedging",
    healed.revision === 1 && (await readAcl(kv, "local.garbled", UG))?.record.allowSubscribe[0] === "general");
  const healedAgain = await reissueAcl(kv, "local.garbled", UG, ["general", "review"]);
  c("subsequent update proceeds normally", healedAgain.revision === 2);

  // ── exhausted retries carry the underlying cause (fake KV; every write path fails) ──
  const boom = new Error("wrong last sequence: 1");
  const fakeKv = {
    get: async () => null,
    create: async () => { throw boom; },
    update: async () => { throw boom; },
  } as unknown as KV;
  try {
    await commitAcl(fakeKv, "local.wedged", UW, ["general"]);
    c("exhausted retries throw", false);
  } catch (e) {
    const err = e as Error;
    c("exhausted throw names the owner", err.message.includes("local.wedged"), err.message);
    c("exhausted throw carries the last underlying error", err.message.includes("wrong last sequence") && err.cause === boom, err.message);
  }

  await nc.drain().catch(() => {});
  console.log(`\nACL CAS SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  if (broker.pid) { try { process.kill(broker.pid, "SIGKILL"); } catch { /* gone */ } }
  await wait(200);
  rmSync(sd, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
