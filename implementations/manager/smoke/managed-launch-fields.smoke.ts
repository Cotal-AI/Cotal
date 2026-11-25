/** The opt-in launch fields `askPermissions` and `reasoningEvents`, from a managed launch request
 *  through a real Manager to the connector, its launch material and the status rows. The seat record
 *  that carries them across a manager restart is proved in supervise-manager-crash.smoke.ts.
 *  A connector that does not declare a field is refused before any provisioning, naming it, and a
 *  launch without the fields carries no trace of them.
 * Run: pnpm smoke:managed-launch-fields
 * Uses an owned JWT broker and private homes. No native harness.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintCreds, newIdentity, setupSpaceStreams, registry, eventChannel, LAUNCH_MATERIAL_ENV, readLaunchMaterial, type LaunchOpts, type Connector } from "@cotal-ai/core";
import { agentCredsDir, authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { launchEnv } from "@cotal-ai/connector-core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { mintControlInstrument } from "../../../packages/workspace/src/connect.js";
import { requestManagedLaunch, type ManagedLaunchRequest } from "../../../packages/workspace/src/launch.js";
import { askManager } from "../../../packages/workspace/src/control/manager.js";
import { materialEnv } from "../../../extensions/connector-core/src/launch.js";
import { configFromEnv } from "../../../extensions/connector-core/src/config.js";
import { Manager } from "../src/manager.js";
import type { ManagerConnectorStatus } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const { check, finish, passed, failed } = createSuite();
const root = mkdtempSync(join(tmpdir(), "managed-launch-fields-"));
const workspaceRoot = join(root, "workspace");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
writeFileSync(join(workspaceRoot, ".cotal", "agents", "probe.md"), "---\nname: probe\n---\nLaunch field seat.\n");
const space = `fields-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth);

const launches: LaunchOpts[] = [];
const corePath = join(import.meta.dirname, "../../../packages/core/dist/index.js");
// A real process joins with the identity and credential the Manager minted, so readiness is real
// and no installed harness is needed.
const child = `import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { CotalEndpoint } = await import(pathToFileURL(process.env.SMOKE_CORE).href);
const o = JSON.parse(process.env.SMOKE_LAUNCH);
const ep = new CotalEndpoint({space:o.space,servers:o.servers,creds:readFileSync(o.creds,'utf8'),
 lifecycleUid:o.lifecycleUid,acceptedToken:o.acceptedToken,channels:[],consume:false,
 registerPresence:true,watchPresence:false,card:{id:o.id,name:o.name,kind:'agent'}});
ep.on('error',e=>console.error(e)); await ep.start(); setInterval(()=>{},1<<30);
`;
const stub = (name: string, extra: Partial<Connector>): Connector => ({
  kind: "connector", name, requires: ["node"], eventChannel, ...extra,
  buildLaunch: (o: LaunchOpts) => {
    launches.push(o);
    return { command: process.execPath, args: ["--input-type=module", "-e", child], env: { ...launchEnv(), SMOKE_CORE: corePath, SMOKE_LAUNCH: JSON.stringify(o) } };
  },
});
registry.register(
  stub("launch-fields-probe", { supportsAskPermissions: true, supportsReasoningEvents: true }),
  stub("launch-fields-plain", {}),
);

/** The launch material a connector writes for `launch`, as the file the session reads. */
function material(launch: LaunchOpts): Record<string, unknown> {
  const env = materialEnv(launch, []);
  return JSON.parse(readFileSync(env[LAUNCH_MATERIAL_ENV]!, "utf8")) as Record<string, unknown>;
}
/** Whether the session's reader refuses material that carries `value` under `key`. */
function refusedOnRead(key: string, value: unknown): boolean {
  const path = join(mkdtempSync(join(root, "material-")), "material.json");
  writeFileSync(path, JSON.stringify({ servers: "nats://127.0.0.1:1", [key]: value }), { mode: 0o600 });
  try {
    readLaunchMaterial(path);
    return false;
  } catch (error) {
    return String(error).includes(`${key} that is not true`);
  }
}
const files = (dir: string): string[] => existsSync(dir) ? readdirSync(dir, { recursive: true }).map(String).sort() : [];

const broker = await bootBroker(auth);
const manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
try {
  await setupSpaceStreams({ space, servers: broker.servers, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  await manager.start();
  const { creds, epCaller } = await mintControlInstrument({ server: broker.servers, space, auth, tlsRequired: false }, "admin");
  const ask = (op: string, args?: Record<string, unknown>) => askManager({ versionSkew: (detail) => detail, roster: async () => [] }, space, broker.servers,
    op, args, { creds, epCaller, tls: false }, "owner", 30_000);
  const launch = (request: Omit<ManagedLaunchRequest, "persona">) => requestManagedLaunch({ persona: "probe", ...request }, (args) => ask("start", args));

  const status = await ask("managerStatus");
  const rows = (status.ok ? (status.data as { connectors: ManagerConnectorStatus[] }).connectors : []);
  const row = (agent: string) => rows.find((r) => r.agent === agent);
  check("status reports both declarations of a connector that makes them",
    row("launch-fields-probe")?.askPermissions === true && row("launch-fields-probe")?.reasoningEvents === true, status);
  check("status reports false for a connector that declares neither",
    row("launch-fields-plain")?.askPermissions === false && row("launch-fields-plain")?.reasoningEvents === false, rows);

  const asked = await launch({ agent: "launch-fields-probe", askPermissions: true, reasoningEvents: true });
  const askedLaunch = launches.at(-1);
  check("a launch with both fields joins", asked.ok, asked);
  check("the connector receives both fields as true", askedLaunch?.askPermissions === true && askedLaunch.reasoningEvents === true, askedLaunch);
  if (askedLaunch) {
    const config = configFromEnv({ ...materialEnv(askedLaunch, []), COTAL_SPACE: space, COTAL_NAME: askedLaunch.name, COTAL_LIFECYCLE_UID: askedLaunch.lifecycleUid });
    check("the session reads both from its launch material as plain booleans", config.askPermissions === true && config.reasoningEvents === true, config);
  }

  const plain = await launch({ agent: "launch-fields-probe" });
  const plainLaunch = launches.at(-1);
  check("a launch without the fields joins", plain.ok && plainLaunch !== askedLaunch, plain);
  check("its launch options carry neither field", plainLaunch !== undefined && !("askPermissions" in plainLaunch) && !("reasoningEvents" in plainLaunch), plainLaunch);
  if (plainLaunch) {
    const written = material(plainLaunch);
    check("its launch material carries neither field", !("askPermissions" in written) && !("reasoningEvents" in written), written);
    const config = configFromEnv({ ...materialEnv(plainLaunch, []), COTAL_SPACE: space, COTAL_NAME: plainLaunch.name, COTAL_LIFECYCLE_UID: plainLaunch.lifecycleUid });
    check("the session reads both as false", config.askPermissions === false && config.reasoningEvents === false, config);
  }
  check("the session refuses material that carries either field as anything but true",
    ["askPermissions", "reasoningEvents"].every((key) => [false, "true", 1].every((value) => refusedOnRead(key, value))));

  const secrets = agentCredsDir(workspaceRoot, space);
  for (const [label, request, refusal] of [
    ["askPermissions on a connector that does not declare it", { agent: "launch-fields-plain", askPermissions: true },
      "launch-fields-plain connector does not support asking before tool use (askPermissions)"],
    ["reasoningEvents on a connector that does not declare it", { agent: "launch-fields-plain", reasoningEvents: true },
      "launch-fields-plain connector does not support reasoning events (reasoningEvents)"],
    ["reasoningEvents on a launch without the event plane", { agent: "launch-fields-probe", reasoningEvents: true, events: false },
      "reasoningEvents needs the event plane"],
  ] as const) {
    const before = { launches: launches.length, files: files(secrets) };
    const refused = await launch(request);
    const error = refused.ok ? "" : String(refused.error);
    check(`${label} is refused, naming the reason`, !refused.ok && error.includes(refusal), refused);
    check(`${label} provisions nothing and launches nothing`,
      launches.length === before.launches && JSON.stringify(files(secrets)) === JSON.stringify(before.files), { before, after: files(secrets) });
  }
  const bad = await ask("start", { name: "probe", agent: "launch-fields-probe", askPermissions: "yes" });
  check("a non-boolean askPermissions is refused by the spawn contract", !bad.ok, bad);
} catch (error) {
  check("the managed launch scenario ran to the end", false, error instanceof Error ? error.stack : error);
} finally {
  await manager.stop({ withAgents: true });
  await delivery?.stop();
  await broker.stop();
}
check("every assertion ran", passed() + failed() === 17, { passed: passed(), failed: failed() });
finish();
