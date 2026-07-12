/**
 * v0.4 serve-credential confinement smoke (SPEC §13.9 serve rows; the D4 half of the split
 * serve-cred/D14 gate) — a real JWT-auth broker proves the RESTRICTED serve profile minted from
 * `epServeGrantRows` (permissionsFor `endpointServe`):
 *   - a registered instance serves and replies THROUGH the restricted credential (positive);
 *   - class-rail admission is queue-qualified ONLY, per registered endpoint + command;
 *   - another instance's rail, an unregistered command, and a foreign endpoint are DENIED;
 *   - egress (reply/epe/ept-schedule/epr) is epoch-pinned: the wrong epoch and the timer
 *     `.armed`/`.fire` phases are DENIED;
 *   - an ordinary caller credential cannot subscribe the class rail or publish unminted rails.
 * The `$JS.API` bind rows (effects/pool durables) and the full cross-resource D32 audit remain
 * the recorded D14 gate.
 *
 * Run: pnpm smoke:ep-serve:auth   (needs nats-server on PATH; part of smoke:ci)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator, type NatsConnection } from "@nats-io/transport-node";
import {
  isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity,
  serveEndpoint, compileContract,
  epRequestSubject, epCallerReplyFilter, epServeFilter, epClassQueueGroup, spacePrefix,
  type EpCaller, type EpServeIdentity, type EndpointReply, type EpCommandDef, type DescribeDescriptor,
} from "../src/index.js";

let ok = 0, fail = 0;
const c = (n: string, v: boolean, extra?: unknown) => { if (v) { ok++; console.log(`  ✓ ${n}`); } else { fail++; console.log("  ✗ FAIL:", n, extra ?? ""); } };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PORT = 12000 + Math.floor(Math.random() * 8000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const space = `epsauth${randomUUID().slice(0, 6).replace(/-/g, "")}`;
const IID = "a".repeat(26);
const IID_B = "b".repeat(26);
const EPOCH = 2;
const UID = "c".repeat(26);
const caller: EpCaller = { owner: "u_abc", actor: "worker", uid: UID };

const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-epsauth-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

const contract = compileContract({ root: { type: "object", properties: { n: { type: "number" } }, additionalProperties: false } });
const D = contract.closureDigest;

/** Connect with `creds`, run `op`, and classify: any async permission/authorization violation
 *  (connection status or subscription callback) ⇒ "denied"; silence ⇒ "allowed". */
async function probe(creds: string, id: string, op: (nc: NatsConnection) => void | Promise<void>, graceMs = 500): Promise<"allowed" | "denied"> {
  const nc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(creds)),
    inboxPrefix: `_INBOX_${id}`,
    maxReconnectAttempts: 0,
  });
  let denied = false;
  void (async () => {
    for await (const s of nc.status()) {
      // The violation rides a {type:"error", error:{name:"PermissionViolationError"}} event.
      if (/permission|authorization/i.test(JSON.stringify(s))) denied = true;
    }
  })().catch(() => {});
  try {
    await op(nc);
    await nc.flush().catch(() => { denied = true; });
    await wait(graceMs);
  } finally {
    await nc.close().catch(() => {});
  }
  return denied ? "denied" : "allowed";
}

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(100); }
  if (!up) throw new Error("auth broker did not come up");

  // ---- mint the restricted profiles ----
  const serveId = newIdentity();
  const serveCreds = await mintCreds(auth, serveId, "agent", {
    principal: { owner: "u_op", actor: "mgr" },
    endpointServe: { endpoint: "manager", instanceId: IID, epoch: EPOCH, commands: ["status", "describe"] },
  });
  const callerId = newIdentity();
  const callerCreds = await mintCreds(auth, callerId, "agent", {
    principal: { owner: "u_abc", actor: "worker" },
    lifecycleUid: UID,
    endpointCapabilities: [
      { endpoint: "manager", command: "status", routes: ["one"] },
      { endpoint: "manager", command: "describe", routes: ["one"] },
    ],
  });

  // ---- POSITIVE: the instance serves and the caller calls, both through restricted creds ----
  const serveNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(serveCreds)),
    inboxPrefix: `_INBOX_${serveId.id}`,
  });
  const identity: EpServeIdentity = { endpoint: "manager", instanceId: IID, epoch: EPOCH };
  const statusDef: EpCommandDef = {
    command: "status", class: "ephemeral",
    contract: { inputDigest: D, outputDigest: D },
    validate: { args: contract.validate, output: contract.validate },
    handler: () => ({ n: 1 }),
  };
  const descriptor: DescribeDescriptor = {
    endpoint: "manager", owner: "u_op", protocol: { v: 1 },
    clusters: [{ digest: D, commands: ["status"] }],
  };
  const handle = serveEndpoint(serveNc, space, identity, [statusDef], { descriptor, authz: { public: true } });
  await serveNc.flush();

  const callerNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(callerCreds)),
    inboxPrefix: `_INBOX_${callerId.id}`,
  });
  const replies: EndpointReply[] = [];
  callerNc.subscribe(epCallerReplyFilter(space, caller), {
    callback: (_e, m) => { replies.push(JSON.parse(new TextDecoder().decode(m.data)) as EndpointReply); },
  });
  await callerNc.flush();
  const NONCE = "n".repeat(24);
  callerNc.publish(
    epRequestSubject(space, { route: { mode: "one" }, endpoint: "manager", command: "status", caller, nonce: NONCE }),
    new TextEncoder().encode(JSON.stringify({
      v: 1, id: "req-1", op: { endpoint: "manager", command: "status", inputDigest: D, outputDigest: D },
      class: "ephemeral", replyExpected: true, deadlineMs: 2000, args: { n: 7 }, from: { id: "u_abc.worker", name: "w" },
    })),
  );
  await callerNc.flush();
  for (let i = 0; i < 40 && replies.length === 0; i++) await wait(50);
  c("the restricted serve credential serves and the restricted caller receives its reply",
    replies.length === 1 && replies[0].ok === true && (replies[0].data as { n: number }).n === 1,
    JSON.stringify(replies));
  await handle.stop();
  await serveNc.close();
  await callerNc.close();

  // ---- DENY: class-rail admission ----
  const p = spacePrefix(space);
  const q = epClassQueueGroup("manager");
  c("serve cred: PLAIN class-rail subscribe is denied (queue-qualified only, §13.9)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(epServeFilter(space, "one", "manager"), { callback: () => {} }); })) === "denied");
  c("serve cred: its own queue-qualified class subscribe is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { queue: q, callback: () => {} }); })) === "allowed");
  c("serve cred: an UNREGISTERED command's class rail is denied (per-command rows)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.stop.>`, { queue: q, callback: () => {} }); })) === "denied");
  c("serve cred: a FOREIGN endpoint's class rail is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.one.delivery.status.>`, { queue: epClassQueueGroup("delivery"), callback: () => {} }); })) === "denied");
  c("serve cred: ANOTHER instance's inst rail is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.subscribe(`${p}.ep.inst.manager.${IID_B}.status.>`, { callback: () => {} }); })) === "denied");

  // ---- DENY: epoch-pinned egress ----
  const replyTail = `u_abc.worker.${UID}.${NONCE}`;
  c("serve cred: reply publish at its OWN epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ep.reply.manager.${IID}.${EPOCH}.${replyTail}`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: reply publish at ANOTHER epoch is denied (epoch-pinned attribution)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ep.reply.manager.${IID}.${EPOCH + 1}.${replyTail}`, new Uint8Array(0)); })) === "denied");
  c("serve cred: event publish at its own epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epe.manager.${IID}.${EPOCH}.progress`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: event publish at another epoch is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epe.manager.${IID}.${EPOCH + 1}.progress`, new Uint8Array(0)); })) === "denied");
  c("serve cred: a timer SCHEDULE request at its own epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ept.manager.${IID}.${EPOCH}.t1.schedule`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: the timer .armed phase is denied (only the timer writer arms, ADR-51 closure)",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.ept.manager.${IID}.${EPOCH}.t1.armed`, new Uint8Array(0)); })) === "denied");
  c("serve cred: record-write ingress at its own epoch is allowed",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID}.${EPOCH}.svc.${IID}`, new Uint8Array(0)); })) === "allowed");
  c("serve cred: record-write ingress at another epoch is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID}.${EPOCH + 1}.svc.${IID}`, new Uint8Array(0)); })) === "denied");
  c("serve cred: another INSTANCE's record ingress is denied",
    (await probe(serveCreds, serveId.id, (nc) => { nc.publish(`${p}.epr.manager.${IID_B}.${EPOCH}.svc.${IID_B}`, new Uint8Array(0)); })) === "denied");

  // ---- DENY: the caller credential holds no serve-side authority ----
  c("caller cred: the class rail is not subscribable, queue or plain (nonces stay private)",
    (await probe(callerCreds, callerId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { queue: q, callback: () => {} }); })) === "denied"
    && (await probe(callerCreds, callerId.id, (nc) => { nc.subscribe(`${p}.ep.one.manager.status.>`, { callback: () => {} }); })) === "denied");
  c("caller cred: an UNMINTED command's request publish is denied (default-deny per capability)",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.ep.one.manager.stop.u_abc.worker.${UID}.${NONCE}`, new Uint8Array(0)); })) === "denied");
  c("caller cred: a reply-rail publish (forged responder) is denied",
    (await probe(callerCreds, callerId.id, (nc) => { nc.publish(`${p}.ep.reply.manager.${IID}.${EPOCH}.${replyTail}`, new Uint8Array(0)); })) === "denied");
} finally {
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => { srv.once("exit", () => resolve()); setTimeout(resolve, 3000); });
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nENDPOINT SERVE AUTH SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${ok} passed, ${fail} failed)`);
process.exit(fail > 0 ? 1 : 0);
