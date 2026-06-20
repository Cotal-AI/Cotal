/**
 * Read-ACL containment smoke (channel-read-acl) — the broker boundary, verified at runtime.
 *
 * Spins up its OWN JWT-auth nats-server and proves that a scoped "agent" cred CANNOT read past its
 * `allowSubscribe`, by exercising the exact JetStream API surface the history reads ride:
 *
 *   A. CAN create a single-filter history consumer on an ALLOWED channel (the granted EX subject).
 *   B. CANNOT smuggle a forbidden filter past the ACL: a create on the allowed EX subject but with a
 *      DIFFERENT `filter_subject` in the body is rejected by nats-server itself
 *      (JSConsumerCreateFilterSubjectMismatchErr, code 10131). ← the load-bearing guarantee.
 *   C. CANNOT create a history consumer on a FORBIDDEN channel (no grant for that EX subject).
 *   D. CANNOT use the bare, filter-less create subject (the multi-filter escape hatch).
 *   E. CANNOT Direct-Get the CHAT stream (the removed unfiltered read hole).
 *   F. CANNOT create/update its own LIVE durable chat_<id> (bind-only — no self-widening).
 *
 * If a future nats-server / nats.js upgrade ever stops enforcing B, this smoke fails loud — the
 * whole read boundary rests on it. Run: pnpm smoke:read-acl:auth
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  chatStream,
  dmStream,
  taskStream,
  chatSubject,
  chatDurable,
  chatHistDurable,
} from "./src/index.js";

const PORT = 14231;
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const enc = (s: string) => new TextEncoder().encode(s);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `read-acl-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-readacl-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const CHAT = chatStream(space);
const allowedFilter = chatSubject(space, "*", "allowed"); // cotal.<space>.chat.*.allowed
const forbiddenFilter = chatSubject(space, "*", "secret"); // never in allowSubscribe

/** Send a JetStream API request and classify the outcome. For a JS API subject there is always a
 *  responder WHEN the publish is permitted, so: "ok"/"jserror" ⇒ the publish passed the ACL and the
 *  server processed it; "blocked" ⇒ the publish was denied (perm violation or dropped → no reply). */
async function jsApi(
  nc: NatsConnection,
  subject: string,
  body: unknown,
): Promise<{ kind: "ok"; data: any } | { kind: "jserror"; err: any } | { kind: "blocked" }> {
  try {
    const m = await nc.request(subject, enc(JSON.stringify(body)), { timeout: 1500 });
    const r = m.json<any>();
    return r?.error ? { kind: "jserror", err: r.error } : { kind: "ok", data: r };
  } catch {
    return { kind: "blocked" }; // permission violation or no reply (publish dropped)
  }
}

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // Manager seeds a couple of messages on #allowed (so the positive read has something to find).
  const mgr = await connect({ servers: SERVERS, authenticator: credsAuthenticator(enc(mgrCreds)) });
  await mgr.publish(chatSubject(space, "MGR", "allowed"), enc("hi"));
  await mgr.publish(chatSubject(space, "MGR", "secret"), enc("classified"));
  await mgr.flush();

  // A scoped agent: read ACL = ["allowed"] only. The stub provisioner skips durable pre-create —
  // we only need the cred's grants, which is what nats-server enforces.
  const noop = { provisionChatDurable: async () => {}, provisionDmInbox: async () => {}, provisionTaskQueue: async () => {} };
  const id = newIdentity();
  const agentCreds = await provisionAgent(noop, auth, id, { subscribe: ["allowed"], allowSubscribe: ["allowed"] });
  const chatHistD = chatHistDurable(id.id);
  const ag = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(enc(agentCreds)),
    inboxPrefix: `_INBOX_${id.id}`, // the agent's sub.allow is _INBOX_<id>.>
    maxReconnectAttempts: 0,
  });
  ag.on?.("error" as any, () => {});

  const cfg = (filter: string) => ({
    stream_name: CHAT,
    config: { name: chatHistD, filter_subject: filter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 1_000_000_000 },
    action: "create",
  });

  // A — allowed channel, body filter matches the subject filter ⇒ created.
  const a = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${allowedFilter}`, cfg(allowedFilter));
  check("A: history consumer on ALLOWED channel is created", a.kind === "ok", a);
  if (a.kind === "ok") await jsApi(ag, `$JS.API.CONSUMER.DELETE.${CHAT}.${chatHistD}`, {}); // cleanup

  // B — body≠subject: allowed EX subject, but a FORBIDDEN filter in the body. nats-server must
  // reject with the filtered-subject-mismatch error (10131). THE load-bearing guarantee.
  const b = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${allowedFilter}`, cfg(forbiddenFilter));
  const mism =
    b.kind === "jserror" &&
    (b.err?.err_code === 10131 || /filtered subject|create subject/i.test(String(b.err?.description ?? "")));
  check("B: body filter ≠ subject filter is REJECTED by nats-server (err 10131)", mism, b);

  // C — forbidden channel's own EX subject: no grant ⇒ publish blocked.
  const c = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatHistD}.${forbiddenFilter}`, cfg(forbiddenFilter));
  check("C: history consumer on a FORBIDDEN channel is blocked", c.kind === "blocked", c);

  // D — bare, filter-less create subject (the multi-filter escape hatch): no grant ⇒ blocked.
  const d = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}`, cfg(forbiddenFilter));
  check("D: bare filter-less create is blocked", d.kind === "blocked", d);

  // E — Direct Get on CHAT (the removed unfiltered read hole): no grant ⇒ blocked.
  const e = await jsApi(ag, `$JS.API.DIRECT.GET.${CHAT}`, { seq: 1 });
  check("E: Direct Get on CHAT is blocked (read hole removed)", e.kind === "blocked", e);

  // F — create/update the agent's OWN live durable chat_<id>: bind-only ⇒ blocked (no self-widen).
  const f = await jsApi(ag, `$JS.API.CONSUMER.CREATE.${CHAT}.${chatDurable(id.id)}`, {
    stream_name: CHAT,
    config: { durable_name: chatDurable(id.id), filter_subjects: [forbiddenFilter], ack_policy: "explicit" },
    action: "create",
  });
  check("F: self-create/update of the live chat_<id> durable is blocked (bind-only)", f.kind === "blocked", f);

  // G — STREAM.INFO on DM/TASK is NOT granted (agents bind by name; granting it would leak DM-inbox
  // and task subject metadata across peers). CHAT STREAM.INFO IS granted (documented metadata surface).
  const gdm = await jsApi(ag, `$JS.API.STREAM.INFO.${dmStream(space)}`, {});
  check("G1: STREAM.INFO on DM is blocked (no DM metadata leak)", gdm.kind === "blocked", gdm);
  const gtask = await jsApi(ag, `$JS.API.STREAM.INFO.${taskStream(space)}`, {});
  check("G2: STREAM.INFO on TASK is blocked", gtask.kind === "blocked", gtask);

  // H — direct message-body read on CHAT (STREAM.MSG.GET) is NOT granted: history must ride the
  // ACL-bounded ephemeral consumers, never a raw per-seq fetch.
  const h = await jsApi(ag, `$JS.API.STREAM.MSG.GET.${CHAT}`, { seq: 1 });
  check("H: STREAM.MSG.GET on CHAT is blocked (no raw message read)", h.kind === "blocked", h);

  // I — channel-token aliasing is rejected before any grant is minted: a policy channel the wire
  // layer would rewrite (foo/bar → foo_bar) must fail loud, or the grant would alias the ACL.
  let aliasRejected = false;
  try {
    await provisionAgent(noop, auth, newIdentity(), { subscribe: ["foo/bar"], allowSubscribe: ["foo/bar"] });
  } catch {
    aliasRejected = true;
  }
  check("I: non-NATS-safe channel (foo/bar) is rejected at provision (no ACL alias)", aliasRejected);

  await ag.drain().catch(() => {});
  await mgr.drain().catch(() => {});
  console.log(`\nREAD-ACL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await wait(150);
  rmSync(dir, { recursive: true, force: true });
}
