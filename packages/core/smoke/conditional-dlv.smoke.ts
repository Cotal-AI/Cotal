import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AckPolicy, DeliverPolicy, jetstreamManager } from "@nats-io/jetstream";
import { connect } from "@nats-io/transport-node";
import {
  CotalEndpoint, composeSpaceAuth, createBrokerAuth, createSpaceAccountAuth, dlvDurable, dlvStream,
  dmDurable, dmStream, isReachable, mintCreds, mintLifecycleUid, newIdentity, permissionsFor,
  provisionAgentDurables, serverConfig, setupSpaceStreams, standaloneConnectOpts,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "@cotal-ai/smoke-kit";

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra?: unknown) => {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const port = await pickFreePort(), servers = `nats://127.0.0.1:${port}`, space = "conditional-dlv";
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const broker = await createBrokerAuth("conditional-dlv");
const account = await createSpaceAccountAuth(broker, space);
const auth = composeSpaceAuth(broker, account);
const conf = join(dir, "server.conf");
writeFileSync(conf, serverConfig(broker, [account], {
  host: "127.0.0.1", port, storeDir: join(dir, "js"), transport: { kind: "plaintext" },
}));
const child = spawn("nats-server", ["-c", conf], { stdio: "ignore" });
const release = teardownOnSignal(child, dir);
let provisioner: CotalEndpoint | undefined;
try {
  for (let i = 0; i < 100 && !(await isReachable(servers)); i++) await wait(50);
  const provisionerId = newIdentity();
  const provisionerCreds = await mintCreds(auth, provisionerId, "provisioner");
  await setupSpaceStreams({ servers, space, creds: provisionerCreds });
  provisioner = new CotalEndpoint({
    space, servers, creds: provisionerCreds, channels: [], consume: false, registerPresence: false,
    watchPresence: false, card: { id: provisionerId.id, name: "provisioner", role: "provisioner", kind: "agent" },
  });
  await provisioner.start();
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds: provisionerCreds, tls: false }) });
  const jsm = await jetstreamManager(nc);
  const uid = mintLifecycleUid(), principal = { owner: "local", actor: "worker", lifecycleUid: uid };
  await provisionAgentDurables(provisioner, principal, { subscribe: [], allowSubscribe: [] });
  const exists = async (stream: string, durable: string) =>
    jsm.consumers.info(stream, durable).then(() => true, () => false);
  check("empty ACL still creates the DM durable",
    await exists(dmStream(space), dmDurable(principal.owner, principal.actor, uid)));
  check("empty ACL omits the DLV durable",
    !(await exists(dlvStream(space), dlvDurable(principal.owner, principal.actor, uid))));

  const rows = (allowSubscribe: string[]) =>
    ((permissionsFor("agent", space, { ...principal, connId: "connection" }, { lifecycleUid: uid, allowSubscribe }) as
      { pub: { allow: string[] } }).pub.allow);
  check("empty ACL credential has no DLV bind or ACK rows",
    !rows([]).some((row) => row.includes(`.${dlvStream(space)}.${dlvDurable(principal.owner, principal.actor, uid)}`) || row.startsWith(`$JS.ACK.${dlvStream(space)}.`)));
  check("nonempty ACL credential has the three DLV bind rows",
    rows(["general"]).filter((row) => row.includes(`.${dlvStream(space)}.${dlvDurable(principal.owner, principal.actor, uid)}`) || row.startsWith(`$JS.ACK.${dlvStream(space)}.`)).length === 3);

  await provisionAgentDurables(provisioner, principal, { subscribe: [], allowSubscribe: ["general"] });
  const info = await jsm.consumers.info(dlvStream(space), dlvDurable(principal.owner, principal.actor, uid));
  check("[] to nonempty regrant creates DLV with unchanged DeliverAll and explicit ACK semantics",
    info.config.deliver_policy === DeliverPolicy.All && info.config.ack_policy === AckPolicy.Explicit,
    info.config);
  const dmInfo = await jsm.consumers.info(dmStream(space), dmDurable(principal.owner, principal.actor, uid));
  check("DM durable remains present and independently configured", dmInfo.config.ack_policy === AckPolicy.Explicit);
  await nc.close();
} finally {
  await provisioner?.stop().catch(() => {});
  await killAndAwaitExit(child, "SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  release();
}
console.log(`\nCONDITIONAL-DLV SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 && pass === 6 ? 0 : 1);
