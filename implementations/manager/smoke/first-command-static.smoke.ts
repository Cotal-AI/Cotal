/** A spawn's first command on a static mesh (SPEC 13.22), from the Manager's `spawn` through a real
 *  Manager to a seat that serves its `agent` endpoint on its static credential and runs the command.
 *  The other first-command refusals still hold there: a target the seats do not run, a spawn that
 *  also names `prompt`, and a `once` spawn. Each provisions nothing and launches nothing.
 * Run: pnpm smoke:first-command-static
 * Uses an owned JWT broker and private homes. No native harness.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, firstCommandId, mintCreds, newIdentity, setupSpaceStreams, registry, type LaunchOpts, type Connector } from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { firstCommandEnv, launchEnv } from "@cotal-ai/connector-core";
import { createSuite } from "@cotal-ai/smoke-kit";
import { mintControlInstrument } from "../../../packages/workspace/src/connect.js";
import { askManager } from "../../../packages/workspace/src/control/manager.js";
import { Manager } from "../src/manager.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const { check, finish, passed, failed } = createSuite();
const root = mkdtempSync(join(tmpdir(), "first-command-static-"));
const workspaceRoot = join(root, "workspace");
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
for (const name of ["first-static", "refused-target", "refused-prompt", "refused-once"])
  writeFileSync(join(workspaceRoot, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\n---\nFirst command seat.\n`);
const space = `first-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
saveSpaceAuth(authDir(workspaceRoot), auth);

const launches: LaunchOpts[] = [];
const report = join(root, "dispatched.json");
const connectorCore = join(import.meta.dirname, "../../../extensions/connector-core/dist/index.js");
// A real MeshAgent joins with the credential the Manager minted and serves its `agent` endpoint. Its
// harness records the command it is asked to start.
const seat = `import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { MeshAgent } = await import(pathToFileURL(process.env.SMOKE_CONNECTOR_CORE).href);
const o = JSON.parse(process.env.SMOKE_LAUNCH);
const commands = { targets: new Set(['command']), async list() { return [{ name: 'probe-cmd', target: 'command' }]; },
 async dispatch(c) { writeFileSync(process.env.SMOKE_REPORT, JSON.stringify(c)); } };
const agent = new MeshAgent({ space: o.space, servers: o.servers, creds: readFileSync(o.creds, 'utf8'), lifecycleUid: o.lifecycleUid,
 acceptedToken: o.acceptedToken, id: o.id, name: o.name, kind: 'agent', tls: false, subscribe: [], allowSubscribe: [], allowPublish: [] },
 process.env, { commands });
agent.on('error', (e) => console.error(e));
agent.on('command', () => void agent.dispatchNextCommand());
await agent.start(); setInterval(() => {}, 1 << 30);
`;
registry.register({
  kind: "connector", name: "first-command-probe", requires: ["node"], supportsPrompt: true,
  commands: { targets: ["command"], list: async () => ({ supported: true, commands: [{ name: "probe-cmd", target: "command" }] }) },
  buildLaunch: (o: LaunchOpts) => {
    launches.push(o);
    const artifacts: string[] = [];
    const env = { ...launchEnv(), ...firstCommandEnv(o.firstCommand, artifacts), SMOKE_CONNECTOR_CORE: connectorCore, SMOKE_LAUNCH: JSON.stringify(o), SMOKE_REPORT: report };
    return { command: process.execPath, args: ["--input-type=module", "-e", seat], env, ...(artifacts.length ? { artifacts } : {}) };
  },
} as Connector);

async function until<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) {
    const value = read();
    if (value !== undefined) return value;
  }
  return undefined;
}

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
  const first = { target: "command", name: "probe-cmd", args: "on a static mesh" };

  const accepted = await ask("start", { name: "first-static", agent: "first-command-probe", firstCommand: first });
  check("a spawn with a first command on a static mesh is accepted", accepted.ok, accepted);
  const goalId = (accepted as { request?: { goalId?: string } }).request?.goalId;
  const handed = launches.at(-1)?.firstCommand;
  check("the connector receives the first command under the id derived from the spawn's goal",
    goalId !== undefined && handed?.id === firstCommandId(goalId) && handed.target === first.target && handed.name === first.name && handed.args === first.args, { goalId, handed });
  const ran = await until(() => (existsSync(report) ? readFileSync(report, "utf8") : undefined), 30_000);
  check("the seat serves its agent endpoint on its static credential and its harness runs the first command", ran === JSON.stringify(first), ran);

  for (const [name, label, args, refusal] of [
    ["refused-target", "a target the seats do not run", { firstCommand: { target: "skill", name: "probe-cmd" } }, "first-command-probe seats run no skills"],
    ["refused-prompt", "a spawn that also names a prompt", { prompt: "hello", firstCommand: first }, "prompt or its first command, not both"],
    ["refused-once", "a once spawn", { once: {}, firstCommand: first }, "a once seat's first turn is its task"],
  ] as const) {
    const before = launches.length;
    const refused = await ask("start", { name, agent: "first-command-probe", ...args });
    check(`on a static mesh ${label} is still refused, naming the reason, and nothing launches`,
      !refused.ok && String(refused.error).includes(refusal) && launches.length === before, refused);
  }
} catch (error) {
  check("the static first-command scenario ran to the end", false, error instanceof Error ? error.stack : error);
} finally {
  await manager.stop({ withAgents: true });
  await delivery?.stop();
  await broker.stop();
}
check("every assertion ran", passed() + failed() === 6, { passed: passed(), failed: failed() });
finish();
