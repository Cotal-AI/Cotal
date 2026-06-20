/**
 * Full multi-agent read/post-ACL end-to-end (channel-read-acl) — the cross-agent enforcement that
 * the single-agent smokes don't cover. Spins its OWN JWT-auth nats-server, provisions three agents
 * with DISTINCT ACLs **from real agent files** (file → loadAgentFile → provisionAgent → creds), and
 * drives a realistic scenario asserting the broker enforces every boundary:
 *
 *   alice: subscribe[general]  allowSubscribe[general, ops]  allowPublish[general]
 *   bob:   subscribe[general]  allowSubscribe[general]       allowPublish[general]
 *   carol: subscribe[general]  allowSubscribe[general]       allowPublish[]  (default-deny)
 *
 *   1. all three boot and backfill #general history (contained ephemeral reads)
 *   2. alice posts #general → bob and carol receive it live
 *   3. carol posts #general → DENIED (default-deny allowPublish), captured as a permission error
 *   4. alice mediated-joins #ops (∈ her allowSubscribe) → succeeds + backfills #ops history
 *   5. bob mediated-joins #ops (∉ his allowSubscribe) → REJECTED by the mediator
 *   6. bob, going around the connector with a raw NATS conn, cannot create a history consumer on
 *      #ops (no per-channel create grant) → broker denies it
 *
 * Run: pnpm smoke:e2e:acl
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  createSpaceAuth, serverConfig, mintCreds, newIdentity, isReachable, loadAgentFile,
  setupSpaceStreams, seedChannelRegistry, provisionAgent, CotalEndpoint,
  CONTROL_SELF_SERVICE, channelInAllow, chatStream, chatSubject, chatHistDurable,
  type CotalMessage, type Delivery, type MessageMeta, type ControlRequest,
} from "./src/index.js";

const PORT = 14241, SERVERS = `nats://127.0.0.1:${PORT}`, space = "e2eacl";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

/** Raw publish to `subject` with `creds`, bypassing the endpoint: a denied publish rejects the
 *  request promptly with a permission violation (deterministic, unlike the async status error the
 *  endpoint path watches); an allowed chat publish has no responder ⇒ times out. */
async function rawPubDenied(creds: string, id: string, subject: string): Promise<boolean> {
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(creds)), inboxPrefix: `_INBOX_${id}`, maxReconnectAttempts: 0 });
  try {
    await nc.request(subject, enc("x"), { timeout: 600 });
    return false; // a responder replied ⇒ allowed (won't happen for a chat subject)
  } catch (e) {
    return /permission|authorization/i.test((e as Error).message); // perm violation ⇒ denied; timeout ⇒ allowed
  } finally {
    await nc.drain().catch(() => {});
  }
}

const dir = mkdtempSync(join(tmpdir(), "cotal-e2e-"));
const auth = await createSpaceAuth(space);
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

/** Write a real agent file and load it back — exercises the file → AgentDef path the launcher uses. */
function agentFile(name: string, fm: string) {
  const path = join(dir, "agents", `${name}.md`);
  mkdirSync(join(dir, "agents"), { recursive: true });
  writeFileSync(path, `---\nname: ${name}\n${fm}\n---\nYou are ${name}.\n`);
  return loadAgentFile(path);
}

try {
  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS, { creds: mgrCreds })) { up = true; break; } await sleep(200); }
  if (!up) throw new Error("auth nats-server did not come up");

  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  await seedChannelRegistry({ servers: SERVERS, space, creds: mgrCreds, file: { defaults: { replay: true }, channels: { general: { replay: true }, ops: { replay: true } } } });

  // The privileged provisioner + mediated-join controller (what the manager is in prod). It knows
  // each agent's allowSubscribe — keyed by id, exactly as ManagedAgent does — and validates joins.
  const allowById = new Map<string, string[]>();
  const mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, card: { name: "mgr", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false });
  mgr.on("error", (e) => console.log("mgr err:", e.message));
  await mgr.start();
  mgr.serveControl(CONTROL_SELF_SERVICE, async (req: ControlRequest) => {
    if (req.op !== "setChannels") return { ok: false, error: `unsupported op ${req.op}` };
    const allow = allowById.get(req.from.id) ?? [];
    const channels = (req.args?.channels as string[]) ?? [];
    for (const ch of channels) if (!channelInAllow(allow, ch)) return { ok: false, error: `"${ch}" outside allowSubscribe` };
    await mgr.setChatFilterFor(req.from.id, channels);
    return { ok: true, data: { channels } };
  });

  // Pre-seed history BEFORE agents connect (so backfill has something to find).
  await mgr.multicast("general-history", { channel: "general" });
  await mgr.multicast("ops-secret-1", { channel: "ops" });
  await mgr.multicast("ops-secret-2", { channel: "ops" });
  await sleep(300);

  // Provision the three agents FROM FILES (file → loadAgentFile → provisionAgent → scoped creds).
  const mk = async (name: string, fm: string) => {
    const def = agentFile(name, fm);
    const ident = newIdentity();
    const allowSubscribe = def.allowSubscribe ?? def.subscribe ?? ["general"];
    allowById.set(ident.id, allowSubscribe);
    const creds = await provisionAgent(mgr, auth, ident, { subscribe: def.subscribe, allowSubscribe, allowPublish: def.allowPublish });
    return { name, ident, creds, def };
  };
  // (0) the loader rejects channel names the wire layer would rewrite — pins the file boundary too.
  console.log("[0] agent-file alias rejection");
  let aliasRejected = false;
  try { agentFile("bad", "subscribe: [foo/bar]\nallowSubscribe: [foo/bar]"); } catch { aliasRejected = true; }
  check("loadAgentFile rejects a non-NATS-safe channel (foo/bar)", aliasRejected);

  const alice = await mk("alice", "subscribe: [general]\nallowSubscribe: [general, ops]\nallowPublish: [general]");
  const bob = await mk("bob", "subscribe: [general]\nallowPublish: [general]");
  const carol = await mk("carol", "subscribe: [general]"); // no allowPublish ⇒ default-deny

  type Got = { channel?: string; text: string; historical: boolean };
  const mkEp = (a: { name: string; ident: { id: string }; creds: string }) => {
    const errors: string[] = [];
    const got: Got[] = [];
    const ep = new CotalEndpoint({ space, servers: SERVERS, creds: a.creds, card: { name: a.name, kind: "agent", id: a.ident.id }, channels: ["general"] });
    ep.on("error", (e: Error) => errors.push(e.message));
    ep.on("message", (m: CotalMessage, d: Delivery, meta?: MessageMeta) => { got.push({ channel: m.channel, text: textOf(m), historical: meta?.historical ?? false }); d.ack(); });
    return { ep, errors, got };
  };
  const A = mkEp(alice), B = mkEp(bob), C = mkEp(carol);
  await Promise.all([A.ep.start(), B.ep.start(), C.ep.start()]);
  await sleep(700);

  // (1) all three backfill #general history, with no permission errors.
  console.log("[1] boot + contained backfill");
  for (const [n, X] of [["alice", A], ["bob", B], ["carol", C]] as const) {
    check(`${n}: backfilled #general history`, X.got.some((g) => g.channel === "general" && g.historical && g.text === "general-history"), X.got);
    check(`${n}: no permission errors on boot`, X.errors.length === 0, X.errors);
    check(`${n}: did NOT receive #ops history (outside subscribe)`, !X.got.some((g) => g.channel === "ops"), X.got);
  }

  // (2) alice posts #general → bob + carol receive it live.
  console.log("[2] post within allowPublish delivers to subscribers");
  await alicePost();
  async function alicePost() { await A.ep.multicast("hello from alice", { channel: "general" }); }
  await sleep(400);
  check("bob received alice's #general post (live)", B.got.some((g) => g.channel === "general" && g.text === "hello from alice"), B.got);
  check("carol received alice's #general post (live)", C.got.some((g) => g.channel === "general" && g.text === "hello from alice"), C.got);

  // (3) carol posts #general → DENIED (default-deny allowPublish). NATS surfaces the publish
  // permission violation on the async status channel → the endpoint's "error" event.
  console.log("[3] default-deny publish is broker-enforced");
  C.errors.length = 0;
  await C.ep.multicast("carol should not post", { channel: "general" }).catch(() => {});
  await sleep(400);
  check("carol's post raised a permission error (default-deny)", C.errors.some((e) => /permission|authorization/i.test(e)), C.errors);
  check("nobody received carol's blocked post", !B.got.concat(A.got).some((g) => g.text === "carol should not post"), "leaked");
  // Same boundary, broker-direct + deterministic: a raw publish with carol's creds is denied.
  check("carol's RAW publish to chat.<id>.general is broker-denied", await rawPubDenied(carol.creds, carol.ident.id, chatSubject(space, carol.ident.id, "general")));

  // (4) alice mediated-joins #ops (∈ her allowSubscribe) → success + backfills #ops history.
  console.log("[4] mediated join within allowSubscribe");
  const aj = await A.ep.joinChannel("ops");
  await sleep(400);
  check("alice joined #ops (∈ allowSubscribe)", aj.joined && aj.backfilled === 2, aj);
  check("alice backfilled #ops history after join", A.got.filter((g) => g.channel === "ops" && g.historical).length === 2, A.got);
  // Live delivery on the newly-joined channel proves the mediated join moved the live-tail FILTER,
  // not just the history backfill — and that bob/carol (not joined) still don't see it.
  await mgr.multicast("ops-live", { channel: "ops" });
  await sleep(400);
  check("alice receives LIVE #ops after join (filter moved)", A.got.some((g) => g.channel === "ops" && g.text === "ops-live" && !g.historical), A.got);
  check("bob does NOT receive #ops live (never joined)", !B.got.some((g) => g.channel === "ops"), B.got);
  check("carol does NOT receive #ops live (never joined)", !C.got.some((g) => g.channel === "ops"), C.got);

  // (5) bob mediated-joins #ops (∉ his allowSubscribe) → REJECTED by the mediator.
  console.log("[5] mediated join outside allowSubscribe is rejected");
  let bobJoinDenied = false;
  try { await B.ep.joinChannel("ops"); } catch { bobJoinDenied = true; }
  check("bob's join of #ops was rejected (outside allowSubscribe)", bobJoinDenied);
  check("bob is not subscribed to #ops", !B.ep.joinedChannels().includes("ops"), B.ep.joinedChannels());

  // (6) bob, bypassing the connector with a raw NATS conn, cannot create a history consumer on #ops
  // (his creds carry no per-channel create grant for ops) → the broker itself denies it.
  console.log("[6] broker denies bob a raw history read of #ops");
  const bobNc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(bob.creds)), inboxPrefix: `_INBOX_${bob.ident.id}`, maxReconnectAttempts: 0 });
  let rawDenied = false;
  try {
    const subj = `$JS.API.CONSUMER.CREATE.${chatStream(space)}.${chatHistDurable(bob.ident.id)}.${chatSubject(space, "*", "ops")}`;
    const m = await bobNc.request(subj, enc(JSON.stringify({ stream_name: chatStream(space), config: { name: chatHistDurable(bob.ident.id), filter_subject: chatSubject(space, "*", "ops"), ack_policy: "none", deliver_policy: "all" }, action: "create" })), { timeout: 1500 });
    const r = m.json<any>();
    rawDenied = !!r?.error; // if it somehow responded, only an error reply counts as denied
  } catch { rawDenied = true; } // permission violation / no responder
  await bobNc.drain().catch(() => {});
  check("bob's raw #ops history create is broker-denied", rawDenied);

  console.log(`\nE2E ACL ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  await Promise.all([A.ep.stop(), B.ep.stop(), C.ep.stop(), mgr.stop()]);
  if (fail) process.exitCode = 1;
} catch (e) {
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await sleep(150);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(process.exitCode ?? (fail ? 1 : 0)); // force-exit: lingering endpoint reconnect timers keep the loop alive
