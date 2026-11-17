/** Real managed surface -> typed start rail -> Manager -> minted credential and connector launch.
 * Run: pnpm exec tsx implementations/manager/smoke/managed-event-payloads.smoke.ts
 * The native leak and request projection have separate pre-fix proofs. Early runs of this
 * harness hit issuance setup refusals, so this suite alone is not the pre-fix failure proof.
 * Uses an owned JWT broker and private homes supplied by the smoke runner. No native harness auth.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceAuth, mintCreds, newIdentity, setupSpaceStreams, registry, eventChannel,
  CotalEndpoint, standaloneConnectOpts, type LaunchOpts, type Connector,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { mintControlInstrument } from "../../../packages/workspace/src/connect.js";
import { requestManagedLaunch } from "../../../packages/workspace/src/launch.js";
import { launchEnv } from "@cotal-ai/connector-core";
import { connect } from "@nats-io/transport-node";
import { memorySubjectFrontier, emitSentinel } from "@cotal-ai/smoke-kit";
import { materialEnv } from "../../../extensions/connector-core/src/launch.js";
import { configFromEnv } from "../../../extensions/connector-core/src/config.js";
import { AguiEmitter } from "../../../extensions/connector-core/src/agui-emitter.js";
import { EventWal } from "../../../extensions/connector-core/src/event-wal.js";
import { JsonlFileSource } from "../../../extensions/connector-core/src/durable-source.js";
import { runStarted, toolCallStart, toolCallArgs, toolCallEnd, toolCallResult } from "../../../extensions/connector-core/src/agui.js";
import { Manager } from "../src/manager.js";
import { askManager } from "../../../packages/workspace/src/control/manager.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const root = mkdtempSync(join(tmpdir(), "managed-event-payloads-"));
const workspaceRoot = join(root, "workspace");
const agents = join(workspaceRoot, ".cotal", "agents");
mkdirSync(agents, { recursive: true });
const space = `payloads-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const [name, policy] of [["default", ""], ["persona-withheld", "eventPayloads: false\n"]])
  writeFileSync(join(agents, `${name}.md`), `---\nname: ${name}\n${policy}---\nRegression seat.\n`);
const epPrincipal = (launch: LaunchOpts) => ({ owner: "local", actor: launch.id! });
const launches = new Map<string, LaunchOpts>();
const corePath = join(import.meta.dirname, "../../../packages/core/dist/index.js");
// A real process joins with precisely the identity and credential the Manager minted. Its only
// purpose is readiness, so the test never depends on an installed harness or native credentials.
const child = `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { CotalEndpoint } = await import(pathToFileURL(process.env.SMOKE_CORE).href);
const o = JSON.parse(process.env.SMOKE_LAUNCH);
const ep = new CotalEndpoint({space:o.space,servers:o.servers,creds:readFileSync(o.creds,'utf8'),
 lifecycleUid:o.lifecycleUid,acceptedToken:o.acceptedToken,channels:[],consume:false,
 registerPresence:true,watchPresence:false,card:{id:o.id,name:o.name,kind:'agent'}});
ep.on('error',e=>console.error(e)); await ep.start(); setInterval(()=>{},1<<30);
`;
const connector: Connector = { kind: "connector", name: "managed-payload-probe", requires: ["node"], eventChannel,
  buildLaunch: (o: LaunchOpts) => {
    launches.set(o.name, o);
    return { command: process.execPath, args: ["--input-type=module", "-e", child],
      env: { ...launchEnv(), SMOKE_CORE: corePath, SMOKE_LAUNCH: JSON.stringify(o) } };
  },
};
registry.register(connector);
let passed = 0, failed = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) passed++; else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
};
const broker = await bootBroker(auth);
const manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  await setupSpaceStreams({ space, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  await manager.start();
  const { creds, epCaller: caller } = await mintControlInstrument({ server: broker.servers, space, auth, tlsRequired: false }, "admin");
  for (const [label, persona, policy, expected] of [
    ["default publishes", "default", undefined, true],
    ["explicit false withholds", "default", false, false],
    ["persona false withholds", "persona-withheld", undefined, false],
  ] as const) {
    const result = await requestManagedLaunch({ persona, agent: "managed-payload-probe", eventPayloads: policy },
      (args) => askManager({ versionSkew: (detail) => detail, roster: async () => [] }, space, broker.servers,
        "start", args, { creds, epCaller: caller, tls: false }, "owner", 30_000));
    check(`${label}: real start joins`, result.ok, result);
    if (!result.ok) continue;
    const name = (result.data as { name: string }).name;
    const launch = launches.get(name);
    check(`${label}: connector receives payload policy`, launch?.eventPayloads === expected, launch?.eventPayloads);
    check(`${label}: names and times remain armed`, launch?.events === true, launch?.events);
    if (!launch?.creds) throw new Error("real start supplied no minted credential");
    const jwt = readFileSync(launch.creds, "utf8").split("\n").find((line) => line.split(".").length === 3)!;
    const claims = JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString());
    const pub: string[] = claims.nats.pub.allow;
    check(`${label}: minted payload publish matches policy`, pub.some((subject) => subject.startsWith(`cotal.${space}.evp.`)) === expected, pub);
    check(`${label}: minted metadata channel remains granted`, pub.some((subject) => subject.includes(".chat.") && subject.includes(".events.")), pub);
    const artifacts: string[] = [];
    const config = configFromEnv({ ...materialEnv(launch, artifacts), COTAL_SPACE: space, COTAL_NAME: name, COTAL_LIFECYCLE_UID: launch.lifecycleUid });
    check(`${label}: sealed launch material carries withholding`, config.eventPayloadsWithheld === !expected, config.eventPayloadsWithheld);
    const observer = await connect({ servers: broker.servers, ...standaloneConnectOpts({ creds: await mintCreds(auth, newIdentity(), "admin"), tls: false }) });
    const received: string[] = [];
    const metadata: string[] = [];
    const metadataSub = observer.subscribe(`cotal.${space}.chat.*.*.${eventChannel(epPrincipal(launch))}`, { callback: (error, message) => { if (error) throw error; metadata.push(new TextDecoder().decode(message.data)); } });
    const subscription = observer.subscribe(`cotal.${space}.evp.>`, { callback: (error, message) => { if (error) throw error; received.push(new TextDecoder().decode(message.data)); } });
    await observer.flush();
    const ep = new CotalEndpoint({ space, servers: broker.servers, creds: readFileSync(launch.creds, "utf8"),
      lifecycleUid: launch.lifecycleUid, acceptedToken: launch.acceptedToken, channels: [], consume: true,
      registerPresence: false, watchPresence: false, card: { id: launch.id, name, kind: "agent" } });
    const dir = join(root, name); mkdirSync(dir);
    const source = join(dir, "source.jsonl"); writeFileSync(source, "");
    try {
      await ep.start();
      const wal = await EventWal.open(join(dir, "wal.json"), { space, threadId: name, principal: ep.principal.owner + "." + ep.principal.actor, subjectMayExist: false });
      const emitter = await AguiEmitter.start({ endpoint: ep, wal, subjectFrontier: memorySubjectFrontier(),
        withholdPayloads: config.eventPayloadsWithheld, source: new JsonlFileSource(source),
        map: () => ({ runId: "run", events: [runStarted({ threadId: name, runId: "run", timestamp: 1 }),
          toolCallStart({ toolCallId: "call", toolCallName: "bash", timestamp: 2 }),
          toolCallArgs({ toolCallId: "call", delta: "managed-input-canary", timestamp: 2 }),
          toolCallEnd({ toolCallId: "call", timestamp: 3 }),
          toolCallResult({ messageId: "result", toolCallId: "call", content: "managed-result-canary", timestamp: 3 })] }) });
      await emitter.pump(); writeFileSync(source, "{}\n"); await emitter.pump();
      await new Promise((resolve) => setTimeout(resolve, 100)); await observer.flush();
      check(`${label}: actual emitter payload publication matches policy`, expected
        ? received.some((body) => body.includes("managed-input-canary") && body.includes("managed-result-canary"))
        : received.length === 0, received);
      check(`${label}: metadata retains call names without inputs or results`, metadata.some((body) => body.includes("bash")) && metadata.every((body) => !body.includes("managed-input-canary") && !body.includes("managed-result-canary")), metadata);
    } finally { await ep.stop(); subscription.unsubscribe(); metadataSub.unsubscribe(); await observer.close(); }
  }
} catch (error) {
  failed++; console.error("FAIL real managed launch scenario", error);
} finally {
  await manager.stop({ withAgents: true });
  await delivery?.stop();
  await broker.stop();
}
check("all three managed launches reached every assertion", passed + failed === 24, { passed, failed });
console.log(`managed event payloads: ${passed} passed, ${failed} failed`);
emitSentinel({ passed, failed });
if (failed) process.exitCode = 1;
