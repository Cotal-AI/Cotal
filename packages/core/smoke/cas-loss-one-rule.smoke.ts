/**
 * A CAS LOSS IS CLASSIFIED BY ONE RULE, AND THAT RULE READS THE BROKER'S STRUCTURED CODE (#3700).
 *
 * "Did this write lose its expected-last-sequence CAS?" used to be answered at five sites, and
 * they did not agree: the exported `isCasLoss` accepted err_code 10071 and 10164; the KV purge
 * accounting accepted 10071 or a message containing "10071" or "wrong last sequence" and omitted
 * 10164; the session ledger kept a private copy with a message-text fallback; two create-only
 * publishes inlined the pair. Which errors took the benign "someone else won" path depended on
 * which copy the author wrote.
 *
 * Two instruments. The tripwire reads the shipped sources: no file but the one that exports the
 * rule may name either code or the message text in code, so a new private copy or a text match
 * cannot return silently. The live cells feed the rule what the broker actually sends for a lost
 * CAS, a stream publish with a stale expectation and a KV purge with a stale revision, and one
 * refusal that is not a CAS loss, so the rule is graded against the real error shape and not a
 * restated one.
 *
 * Needs nats-server on PATH.
 * Run: pnpm smoke:cas-loss-one-rule
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { isCasLoss, isReachable } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

let cells = 0, failed = 0;
const ok = (name: string, cond: boolean, detail?: unknown): void => {
  cells++;
  if (cond) { console.log(`  ✓ ${name}`); return; }
  failed++;
  console.log(`  x FAIL  ${name}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- 1. The tripwire: the classification lives in endpoint-records.ts and nowhere else ----
console.log("\n1. one rule in the shipped sources");
const roots = [
  fileURLToPath(new URL("../src/", import.meta.url)),
  fileURLToPath(new URL("../../../implementations/auth/src/", import.meta.url)),
];
const RULE_FILE = "endpoint-records.ts";
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const p = join(dir, name);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
});
const CODE_COMMENT = /^\s*(\/\/|\/\*|\*)/;
const NAMES_THE_RULE = /\b10071\b|\b10164\b|wrong last sequence/i;
const strays: string[] = [];
let scanned = 0;
for (const root of roots) {
  for (const file of walk(root)) {
    scanned++;
    if (file.endsWith(`/${RULE_FILE}`)) continue;
    readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (!CODE_COMMENT.test(line) && NAMES_THE_RULE.test(line)) strays.push(`${relative(roots[0], file)}:${i + 1}`);
    });
  }
}
ok(`1.1 CONTROL: the scan read the core and auth sources (${scanned} files)`, scanned > 100, { scanned });
ok("1.2 no source but endpoint-records.ts names 10071, 10164 or \"wrong last sequence\" in code", strays.length === 0, strays);

// ---- 2. The rule against the broker's real CAS-loss shape ----
console.log("\n2. the rule against real broker errors");
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = spawn("nats-server", ["-js", "-sd", join(dir, "js"), "-p", String(PORT), "-a", "127.0.0.1"], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(broker, dir);
try {
  let up = false;
  for (let i = 0; i < 100; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(100); }
  if (!up) throw new Error(`fixture broker never came up on ${SERVERS} - refusing to report on a server that never started`);
  const nc = await connect({ servers: SERVERS });
  const jsm = await jetstreamManager(nc);
  const js = jetstream(nc);
  await jsm.streams.add({ name: "CASRULE", subjects: ["casrule.>"] });
  const first = await js.publish("casrule.a", "one");
  const caught = async (fn: () => Promise<unknown>): Promise<unknown> => { try { await fn(); return undefined; } catch (e) { return e; } };

  const stale = await caught(() => js.publish("casrule.a", "two", { expect: { lastSubjectSequence: first.seq + 7 } }));
  ok("2.1 a stream publish with a stale expected-last-subject-sequence is a CAS loss", stale !== undefined && isCasLoss(stale), { code: (stale as { code?: unknown })?.code, message: (stale as Error)?.message });

  const kv = await new Kvm(nc).create("casrule");
  const rev = await kv.put("k", "v");
  const stalePurge = await caught(() => kv.purge("k", { previousSeq: rev + 5 }));
  ok("2.2 a KV purge with a stale revision is a CAS loss (the accounting purge's path)", stalePurge !== undefined && isCasLoss(stalePurge), { code: (stalePurge as { code?: unknown })?.code });

  const noStream = await caught(() => js.publish("nostream.a", "x"));
  ok("2.3 CONTROL: a publish refused for another reason is not a CAS loss", noStream !== undefined && !isCasLoss(noStream), { code: (noStream as { code?: unknown })?.code, message: (noStream as Error)?.message });
  ok("2.4 CONTROL: a message that merely says \"wrong last sequence\" without the code is not a CAS loss", !isCasLoss(new Error("wrong last sequence: 3")));

  await nc.close();
} finally {
  releaseBroker();
  broker.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0
  ? `cas-loss-one-rule smoke: ${cells} checks passed`
  : `cas-loss-one-rule smoke: ${failed} of ${cells} FAILED`);
process.exit(failed === 0 ? 0 : 1);
