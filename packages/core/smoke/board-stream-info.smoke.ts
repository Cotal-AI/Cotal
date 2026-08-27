/**
 * Live repro for GitHub #903 against a throwaway JWT-auth nats-server this suite owns.
 *
 * The issue titles a `role: "board"` grant-template defect. This file mints the way a real
 * board is minted (`provisionAgent` + `role: "board"`), then reads the credential and the
 * broker rather than the title.
 *
 * What it proves:
 *   1. `role` is the anycast queue name. It is not a `permissionsFor` profile. The board
 *      principal is minted through the `agent` arm. `permissionsFor("board")` throws.
 *   2. The agent JWT carries the consumer-create deny triple on DM/TASK/DLV (9 deny rows)
 *      and does not carry `$JS.API.STREAM.INFO` on those streams. Presence KV does carry
 *      CONSUMER.CREATE/INFO/DELETE, which is why the issue's presence fixture passes.
 *   3. Publishing `$JS.API.STREAM.INFO.DM_<space>` as the board is a broker Publish
 *      Violation. The same call on CHAT and on `KV_cotal_presence_<space>` is allowed.
 *   4. `CotalEndpoint.dmHistory` on that board returns `[]` even when a DM is on the
 *      stream: `streamHistory` swallows a DM permission denial as an empty page.
 *   5. The STREAM.INFO call is a nats.js ordered-consumer helper (`ConsumersImpl.ordered`
 *      → `StreamAPIImpl.info`) used by `lastMatchingSeq` / `drainWindow`. Granting
 *      STREAM.INFO would not admit the subsequent CONSUMER.CREATE, which the same arm
 *      denies.
 *   6. EPC has a subject-scoped DIRECT.GET grant and no consumer-create deny triple. It
 *      is not a fourth instance of the DM/TASK/DLV template.
 *
 * This suite does not add a grant. Adding STREAM.INFO on DM is the agent-arm decision
 * `read-acl-auth.smoke.ts` G1 already locks: it would leak DM-inbox subject metadata.
 *
 * Run: pnpm smoke:board-stream-info
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import {
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  mintLifecycleUid,
  CotalEndpoint,
  permissionsFor,
  chatStream,
  dmStream,
  dlvStream,
  taskStream,
  epcStreamName,
  presenceBucket,
  spacePrefix,
  DEV_OWNER,
  type CotalMessage,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
const enc = (s: string) => new TextEncoder().encode(s);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

function jwtPayload(creds: string): {
  pub: { allow: string[]; deny: string[] };
  sub: { allow: string[]; deny: string[] };
} {
  const jwt = /-----BEGIN NATS USER JWT-----\s*(\S+)/.exec(creds)?.[1];
  if (!jwt) throw new Error("creds file has no user JWT");
  const nats = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString("utf8")).nats as {
    pub?: { allow?: string[]; deny?: string[] };
    sub?: { allow?: string[]; deny?: string[] };
  };
  return {
    pub: { allow: nats.pub?.allow ?? [], deny: nats.pub?.deny ?? [] },
    sub: { allow: nats.sub?.allow ?? [], deny: nats.sub?.deny ?? [] },
  };
}

function denyTriple(stream: string): [string, string, string] {
  return [
    `$JS.API.CONSUMER.CREATE.${stream}`,
    `$JS.API.CONSUMER.CREATE.${stream}.>`,
    `$JS.API.CONSUMER.DURABLE.CREATE.${stream}.>`,
  ];
}

async function jsApi(
  nc: NatsConnection,
  subject: string,
  body: unknown,
): Promise<{ kind: "ok"; data: unknown } | { kind: "jserror"; err: unknown } | { kind: "blocked" }> {
  try {
    const m = await nc.request(subject, enc(JSON.stringify(body)), { timeout: 1500 });
    const r = m.json<{ error?: unknown }>();
    return r?.error ? { kind: "jserror", err: r.error } : { kind: "ok", data: r };
  } catch {
    return { kind: "blocked" };
  }
}

const space = `board-info-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const log: string[] = [];
const srv = spawn("nats-server", ["-c", join(dir, "server.conf"), "-DV"], {
  stdio: ["ignore", "pipe", "pipe"],
});
const releaseBroker = teardownOnSignal(srv, dir);
for (const stream of [srv.stdout, srv.stderr]) {
  stream?.on("data", (buf: Buffer) => {
    for (const line of buf.toString("utf8").split("\n")) if (line) log.push(line);
  });
}

const CHAT = chatStream(space);
const DM = dmStream(space);
const DLV = dlvStream(space);
const TASK = taskStream(space);
const EPC = epcStreamName(space);
const KV = `KV_${presenceBucket(space)}`;

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // ---- (a) role is not profile ---------------------------------------------------------------
  let boardProfileThrew = "";
  try {
    const id = newIdentity();
    permissionsFor("board" as "agent", space, { owner: DEV_OWNER, actor: id.id, connId: id.id, lifecycleUid: mintLifecycleUid() }, {});
  } catch (e) {
    boardProfileThrew = (e as Error).message;
  }
  check(
    "permissionsFor(\"board\") throws (board is not a profile arm)",
    /unhandled profile "board"/.test(boardProfileThrew),
    boardProfileThrew,
  );

  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const prov = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { name: "prov", kind: "endpoint" }, consume: false, watchPresence: false, registerPresence: false,
  });
  await prov.start();

  const boardId = newIdentity();
  const boardUid = mintLifecycleUid();
  const boardCreds = await provisionAgent(prov, auth, boardId, {
    subscribe: ["general"],
    allowSubscribe: ["general"],
    role: "board",
    lifecycleUid: boardUid,
  });
  const grants = jwtPayload(boardCreds);
  check("a role:\"board\" mint is the agent arm: 9 pub.deny rows (3 streams × the create triple)", grants.pub.deny.length === 9, grants.pub.deny);
  for (const stream of [DM, TASK, DLV] as const) {
    const triple = denyTriple(stream);
    check(`  deny triple present for ${stream}`, triple.every((s) => grants.pub.deny.includes(s)), { stream, deny: grants.pub.deny.filter((s) => s.includes(stream)) });
    check(`  STREAM.INFO absent for ${stream}`, !grants.pub.allow.some((s) => s === `$JS.API.STREAM.INFO.${stream}`), grants.pub.allow.filter((s) => s.includes(stream)));
  }
  check("  STREAM.INFO granted on CHAT (documented metadata surface)", grants.pub.allow.includes(`$JS.API.STREAM.INFO.${CHAT}`));
  check("  STREAM.INFO granted on presence KV (the issue's passing control)", grants.pub.allow.includes(`$JS.API.STREAM.INFO.${KV}`));
  check("  EPC is not in pub.deny (no consumer-create deny triple)", !grants.pub.deny.some((s) => s.includes(EPC)), grants.pub.deny);
  check("  EPC STREAM.INFO is also absent (a different template: DIRECT.GET only)", !grants.pub.allow.some((s) => s === `$JS.API.STREAM.INFO.${EPC}`));
  check("  EPC Direct Get IS granted (baseline, subject-scoped)", grants.pub.allow.some((s) => s.startsWith(`$JS.API.DIRECT.GET.${EPC}.`)), grants.pub.allow.filter((s) => s.includes("EPC")));

  const board = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(enc(boardCreds)),
    inboxPrefix: `_INBOX_${boardId.id}`,
    maxReconnectAttempts: 0,
    name: "cotal:foreman",
  });

  // ---- (c) live broker denial ----------------------------------------------------------------
  const before = log.length;
  const gdm = await jsApi(board, `$JS.API.STREAM.INFO.${DM}`, {});
  check("STREAM.INFO on DM is blocked at the broker (publish plane)", gdm.kind === "blocked", gdm);
  await wait(200);
  const violations = log.slice(before).filter((l) => /Publish Violation/.test(l) && l.includes(`$JS.API.STREAM.INFO.${DM}`));
  check("broker stderr names the STREAM.INFO.DM Publish Violation", violations.length >= 1, { sample: violations[0], scanned: log.slice(before).slice(-8) });

  const gchat = await jsApi(board, `$JS.API.STREAM.INFO.${CHAT}`, {});
  check("STREAM.INFO on CHAT is allowed (positive control, same cred)", gchat.kind === "ok", gchat);
  const gkv = await jsApi(board, `$JS.API.STREAM.INFO.${KV}`, {});
  check("STREAM.INFO on presence KV is allowed (the issue's passing control, same cred)", gkv.kind === "ok", gkv);
  const gdlv = await jsApi(board, `$JS.API.STREAM.INFO.${DLV}`, {});
  check("STREAM.INFO on DLV is blocked (latent sibling of the DM row, same deny-triple template)", gdlv.kind === "blocked", gdlv);
  const gtask = await jsApi(board, `$JS.API.STREAM.INFO.${TASK}`, {});
  check("STREAM.INFO on TASK is blocked (latent sibling of the DM row, same deny-triple template)", gtask.kind === "blocked", gtask);
  const gepc = await jsApi(board, `$JS.API.STREAM.INFO.${EPC}`, {});
  check("STREAM.INFO on EPC is blocked (absent grant, but NOT the deny-triple template)", gepc.kind === "blocked", gepc);

  // The issue's passing presence fixture: CREATE/INFO/DELETE with the consumer-name token.
  // The grant is `${KV}.>` so a trailing filter is required; a body/subject mismatch is 10131
  // (the publish was admitted), not a Publish Violation.
  const ocName = `oc_board_${randomUUID().slice(0, 6)}`;
  const kvFilter = `$KV.${presenceBucket(space)}.>`;
  const presenceCreate = await jsApi(board, `$JS.API.CONSUMER.CREATE.${KV}.${ocName}.${kvFilter}`, {
    stream_name: KV,
    config: { name: ocName, filter_subject: kvFilter, ack_policy: "none", deliver_policy: "all", inactive_threshold: 1_000_000_000 },
    action: "create",
  });
  check("presence KV CONSUMER.CREATE with a consumer-name token is allowed (issue control)", presenceCreate.kind === "ok", presenceCreate);
  const presenceInfo = await jsApi(board, `$JS.API.CONSUMER.INFO.${KV}.${ocName}`, {});
  check("presence KV CONSUMER.INFO with that name is allowed", presenceInfo.kind === "ok", presenceInfo);
  const presenceDelete = await jsApi(board, `$JS.API.CONSUMER.DELETE.${KV}.${ocName}`, {});
  check("presence KV CONSUMER.DELETE with that name is allowed", presenceDelete.kind === "ok", presenceDelete);

  // A DM exists on the stream. The board's bind-only durable can consume it; dmHistory cannot.
  const peerId = newIdentity();
  const peerUid = mintLifecycleUid();
  const peerCreds = await provisionAgent(prov, auth, peerId, {
    subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"], lifecycleUid: peerUid,
  });
  const peer = new CotalEndpoint({
    space, servers: SERVERS, creds: peerCreds, lifecycleUid: peerUid,
    card: { name: "peer", kind: "agent" }, channels: [], watchChannels: false, watchPresence: false, registerPresence: false,
  });
  await peer.start();
  const boardEp = new CotalEndpoint({
    space, servers: SERVERS, creds: boardCreds, lifecycleUid: boardUid,
    card: { name: "foreman", kind: "agent", role: "board" }, channels: [],
    watchChannels: false, watchPresence: false, registerPresence: false,
  });
  const textOf = (m: CotalMessage) => m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
  const seen: string[] = [];
  const boardErrors: string[] = [];
  boardEp.on("error", (e: Error) => { boardErrors.push(e.message); });
  boardEp.on("message", (m, _d, meta) => { if (meta?.kind === "dm") seen.push(textOf(m)); });
  await boardEp.start();
  await peer.unicast(boardEp.card.id, "task.update please");
  let delivered = false;
  for (let i = 0; i < 40; i++) { if (seen.includes("task.update please")) { delivered = true; break; } await wait(50); }
  check("the board's bind-only DM durable DID receive the message (inbox works)", delivered, seen);

  const page = await boardEp.dmHistory({ limit: 10 });
  check("dmHistory on the board returns [] (permission denial swallowed as empty view)", Array.isArray(page) && page.length === 0, page);
  check("the swallowed denial is the STREAM.INFO.DM publish (async status, empty page)", boardErrors.some((e) => e.includes(`$JS.API.STREAM.INFO.${DM}`)), boardErrors);

  // The helper the dashboard path rides: nats.js ordered() probes STREAM.INFO first.
  const js = jetstream(board);
  const beforeOrdered = log.length;
  let orderedErr = "";
  try {
    await js.consumers.get(DM, { filter_subjects: [`${spacePrefix(space)}.inst.>`] });
  } catch (e) {
    orderedErr = (e as Error).message;
  }
  await wait(200);
  const orderedViolations = log.slice(beforeOrdered).filter((l) => /Publish Violation/.test(l) && l.includes(`$JS.API.STREAM.INFO.${DM}`));
  check("nats.js consumers.get(stream, {filter_subjects}) is refused (ordered helper probes STREAM.INFO)", orderedErr.length > 0, orderedErr);
  check("that helper is what emits the STREAM.INFO.DM Publish Violation", orderedViolations.length >= 1, orderedViolations[0]);

  // Granting STREAM.INFO would not admit the create the helper does next.
  const createAfterInfo = await jsApi(board, `$JS.API.CONSUMER.CREATE.${DM}`, {
    stream_name: DM,
    config: { ack_policy: "none", deliver_policy: "last", filter_subjects: [`${spacePrefix(space)}.inst.>`] },
    action: "create",
  });
  check("CONSUMER.CREATE on DM stays blocked (so a STREAM.INFO grant would not make dmHistory work)", createAfterInfo.kind === "blocked", createAfterInfo);

  await boardEp.stop().catch(() => {});
  await peer.stop().catch(() => {});
  await board.drain().catch(() => {});
  await prov.stop().catch(() => {});
  console.log(`\nBOARD-STREAM-INFO SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker();
}
