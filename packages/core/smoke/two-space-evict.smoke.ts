import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import {
  createBrokerAuth, createSpaceAccountAuth, isReachable, mintConnectionEvictorCreds, mintCreds,
  mintKickHolderCreds, mintKickRequestListenerCreds, mintMembershipObserverCreds, newIdentity,
  serverConfig, serverKickSubject, serveKickHolder, setupSpaceStreams, MEMBERSHIP_INBOX_PREFIX,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";

const port = await pickFreePort();
const servers = `nats://127.0.0.1:${port}`;
const enc = (s: string) => new TextEncoder().encode(s);
const broker = await createBrokerAuth("shared");
const first = await createSpaceAccountAuth(broker, "alpha");
const second = await createSpaceAccountAuth(broker, "beta");
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(broker, [first, second], { transport: { kind: "plaintext" }, port, storeDir: join(dir, "js") }));
const child = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const release = teardownOnSignal(child, dir);
let failed = "";
try {
  for (let i = 0; i < 50 && !(await isReachable(servers)); i++) await new Promise((r) => setTimeout(r, 100));
  const alpha = { ...first, operator: broker.operator, sys: broker.sys, space: "alpha" };
  const beta = { ...second, operator: broker.operator, sys: broker.sys, space: "beta" };
  const stored = await mintConnectionEvictorCreds(alpha, newIdentity());
  const requester = await connect({ servers, authenticator: credsAuthenticator(enc(stored)), reconnect: false });
  let rawDenied = false;
  try { await requester.request(serverKickSubject("foreign-server"), enc(JSON.stringify({ cid: 1 })), { timeout: 1000 }); }
  catch (e) { rawDenied = /permissions/i.test((e as Error).message); }
  const persisted = { ...alpha, sys: { ...broker.sys, signingSeed: undefined } };
  let refused = false;
  try { await mintConnectionEvictorCreds(persisted, newIdentity()); } catch (e) { refused = /system-account signing seed/i.test((e as Error).message); }
  const listener = await connect({ servers, authenticator: credsAuthenticator(enc(await mintKickRequestListenerCreds(alpha, newIdentity()))), reconnect: false });
  const holder = await connect({ servers, authenticator: credsAuthenticator(enc(await mintKickHolderCreds(alpha, newIdentity()))), reconnect: false });
  const census = await connect({ servers, authenticator: credsAuthenticator(enc(await mintMembershipObserverCreds(alpha, newIdentity()))), inboxPrefix: MEMBERSHIP_INBOX_PREFIX, reconnect: false });
  const served = await serveKickHolder({ requests: listener, kicker: holder, census, accountId: first.account.pub, space: "alpha" });
  const own = await connect({ servers, authenticator: credsAuthenticator(enc(await mintCreds(alpha, newIdentity(), "provisioner"))), reconnect: false });
  await setupSpaceStreams({ servers, space: "alpha", creds: await mintCreds(alpha, newIdentity(), "provisioner") });
  const foreign = await connect({ servers, authenticator: credsAuthenticator(enc(await mintCreds(beta, newIdentity(), "provisioner"))), reconnect: false });
  const info = foreign.info;
  const reply = await requester.request("cotal.alpha.ctl.kick", enc(JSON.stringify({ serverId: info?.server_id, cid: info?.client_id })), { timeout: 2000 });
  const body = reply.json() as { error?: { description?: string } };
  const foreignRefused = Boolean(body.error);
  const foreignStayed = !foreign.isClosed();
  await foreign.close(); await own.close(); await served.close(); await Promise.all([requester, listener, holder, census].map((nc) => nc.close()));
  const result = { rawDenied, preFixRefusal: refused, foreignRefused: Boolean(body.error), foreignStayed, secondSpace: second.space };
  if (!rawDenied || !foreignRefused || !foreignStayed) failed = JSON.stringify(result);
  else console.log(JSON.stringify(result));
} finally {
  child.kill("SIGTERM"); release(); rmSync(dir, { recursive: true, force: true });
}
if (failed) { console.error(failed); process.exit(1); }
