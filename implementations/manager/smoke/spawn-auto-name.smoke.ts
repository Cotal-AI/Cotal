/**
 * `spawn` `autoName` (SPEC §9, 13.22): the Manager forwards it to the seat's launch and never passes
 * it again when it restarts the same lifecycle.
 *
 * Live: a JWT-auth scratch broker, the real Manager on its served `spawn`, and a real childless stub
 * that joins presence. The launch the connector receives is read back, and its env comes from the
 * shipped `nameEnv` and `configFromEnv`. SIGKILL is the crash that makes the supervised restart.
 * Also: the contract's revision and schema, a non-boolean `autoName`, and a `once` spawn with it.
 *
 * Run: pnpm smoke:manager-spawn-auto-name   (needs nats-server + node on PATH)
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth, mintCreds, newIdentity, mintLifecycleUid, standaloneConnectOpts, setupSpaceStreams,
  DEV_OWNER, epCall, readGoalResult, registry,
  type Connector, type EpCaller, type LaunchOpts, type LaunchSpec,
} from "@cotal-ai/core";
import { authDir, saveSpaceAuth, workspaceSecretStore } from "@cotal-ai/workspace";
import { createSuite } from "@cotal-ai/smoke-kit";
import { configFromEnv } from "../../../extensions/connector-core/src/config.js";
import { nameEnv } from "../../../extensions/connector-core/src/launch.js";
import { Manager } from "../src/manager.js";
import { childlessRuntime } from "./_childless-runtime.js";
import { MANAGER_ENDPOINT, MANAGER_CONTRACTS, managerShippedSurface } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";
import { bootDeliveryDaemon } from "./_boot-delivery.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const STUB = join(here, "e2e-stub.mjs");
const { check, finish } = createSuite();
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.log("the contract");
{
  const input = MANAGER_CONTRACTS.spawn.input;
  check("the Manager cluster is at revision 59", managerShippedSurface().revision === 59, managerShippedSurface().revision);
  check("spawn accepts autoName true, false or absent", [true, false, undefined].every((autoName) => input.validate({ name: "probe", ...(autoName === undefined ? {} : { autoName }) })));
  check("spawn refuses a non-boolean autoName", !input.validate({ name: "probe", autoName: "true" }) && !input.validate({ name: "probe", autoName: 1 }));
}

const space = `autoname-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const broker = await bootBroker(auth);
const workspaceRoot = mkdtempSync(join(tmpdir(), "cotal-spawn-auto-name-"));
mkdirSync(join(workspaceRoot, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(workspaceRoot), auth);
for (const name of ["named", "plain", "loose", "once"]) writeFileSync(join(workspaceRoot, ".cotal", "agents", `${name}.md`), `---\nname: ${name}\n---\n`);

const launches: LaunchOpts[] = [];
const launchesOf = (name: string) => launches.filter((o) => o.name === name);
// What the seat reads its names from: the launch env every shipped connector builds with `nameEnv`.
const seatConfig = (o: LaunchOpts) => configFromEnv({ COTAL_SPACE: o.space, COTAL_ID: String(o.id), ...nameEnv(o) });
const stub: Connector = {
  kind: "connector",
  name: "auto-name-stub",
  requires: ["node"],
  // Only so a once spawn reaches the once checks; no prompt is ever launched here.
  supportsPrompt: true,
  supportsTurnRelay: true,
  buildLaunch: (o): LaunchSpec => {
    launches.push(o);
    return {
      command: "node", args: [STUB],
      env: {
        COTAL_SPACE: o.space, COTAL_SERVERS: String(o.servers ?? broker.servers), COTAL_CREDS: String(o.creds),
        COTAL_ID: String(o.id), PATH: process.env.PATH ?? "", ...nameEnv(o),
        ...(o.lifecycleUid ? { COTAL_LIFECYCLE_UID: o.lifecycleUid } : {}),
      },
    };
  },
};
registry.register(stub);

const home = mkdtempSync(join(tmpdir(), "cotal-spawn-auto-name-home-"));
const prevHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = home;

let manager: Manager | undefined;
let delivery: Awaited<ReturnType<typeof bootDeliveryDaemon>> | undefined;
let runnerNc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: broker.servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  delivery = await bootDeliveryDaemon({ space, servers: broker.servers, auth, reloadStoreIdentity: workspaceSecretStore(workspaceRoot).identity });
  manager = new Manager({ space, servers: broker.servers, runtime: "pty", workspaceRoot });
  await manager.start();
  const M = manager as unknown as { agents: Map<string, { handle: { pid?: number }; lifecycleUid: string; restart?: { recovering: boolean } }> };
  // e2e-stub.mjs starts no child process, so its exit proves its work ended and supervise can restart it.
  childlessRuntime((manager as unknown as { runtime: import("@cotal-ai/core").Runtime }).runtime, join(workspaceRoot, "childless-runtime"),
    (spec) => spec.command === "node" && spec.args.length === 1 && spec.args[0] === STUB);

  const runnerId = newIdentity();
  const runner: EpCaller = { owner: DEV_OWNER, actor: runnerId.id, uid: mintLifecycleUid() };
  runnerNc = await connect({
    servers: broker.servers,
    ...standaloneConnectOpts({ creds: await mintCreds(auth, runnerId, "control-caller-admin", { lifecycleUid: runner.uid }), tls: false }),
    maxReconnectAttempts: 0,
  });
  const spawn = async (id: string, args: Record<string, unknown>) => {
    try {
      return (await epCall(runnerNc!, space, { mode: "one" }, {
        endpoint: MANAGER_ENDPOINT, command: "spawn", contract: MANAGER_CONTRACTS.spawn, caller: runner, id: id.padEnd(43, "s"), args,
      }, { deadlineMs: 20_000, currentEpoch: async () => 0 })).reply;
    } catch (e) {
      return { ok: false, error: { code: (e as { code?: string }).code, message: (e as Error).message } };
    }
  };
  const actx = (manager as unknown as { goalWriterComponent: { goalWriter: { ctx: Parameters<typeof readGoalResult>[0] } } }).goalWriterComponent.goalWriter.ctx;
  const joined = async (id: string): Promise<boolean> => {
    for (const end = Date.now() + 60_000; Date.now() < end; await wait(200)) {
      const fact = await readGoalResult(actx, { endpoint: MANAGER_ENDPOINT, caller: runner, goalId: id.padEnd(43, "s") });
      if (fact !== undefined) return fact.state === "succeeded";
    }
    return false;
  };

  console.log("\na spawn with autoName");
  {
    const r = await spawn("spawn-named", { name: "named", agent: "auto-name-stub", cwd: repoRoot, events: false, autoName: true, supervise: { restarts: 1, windowMs: 60_000 } });
    check("is accepted and the seat joins", (r as { ok?: boolean }).ok === true && await joined("spawn-named"), r);
    const first = launchesOf("named")[0];
    check("the connector's launch carries autoName", first?.autoName === true, first?.autoName);
    check("and the seat's launch env asks it to label itself (COTAL_AUTO_NAME=1)", first !== undefined && nameEnv(first).COTAL_AUTO_NAME === "1" && seatConfig(first).autoName === true,
      first && nameEnv(first));
    const row = M.agents.get("named");
    const pid = row?.handle.pid;
    if (typeof pid === "number") process.kill(pid, "SIGKILL");
    let relaunched = false;
    for (const end = Date.now() + 30_000; Date.now() < end && !relaunched; await wait(50)) {
      const cur = M.agents.get("named");
      relaunched = launchesOf("named").length === 2 && cur?.handle.pid !== undefined && cur.handle.pid !== pid && cur.restart?.recovering === false;
    }
    const second = launchesOf("named")[1];
    check("a supervised restart of the same lifecycle launches it again", relaunched && M.agents.get("named")?.lifecycleUid === row?.lifecycleUid, launchesOf("named").length);
    check("without autoName, so the seat does not label itself again", second !== undefined && second.autoName === undefined && nameEnv(second).COTAL_AUTO_NAME === undefined && seatConfig(second).autoName === undefined,
      second && { autoName: second.autoName, env: nameEnv(second) });
  }

  console.log("\na spawn without autoName");
  {
    const r = await spawn("spawn-plain", { name: "plain", agent: "auto-name-stub", cwd: repoRoot, events: false });
    await joined("spawn-plain");
    const launch = launchesOf("plain")[0];
    check("launches with no autoName and no COTAL_AUTO_NAME", (r as { ok?: boolean }).ok === true && launch !== undefined && launch.autoName === undefined && nameEnv(launch).COTAL_AUTO_NAME === undefined,
      { r, autoName: launch?.autoName });
  }

  console.log("\nrefused spawns");
  {
    const before = launches.length;
    const loose = await spawn("spawn-loose", { name: "loose", agent: "auto-name-stub", cwd: repoRoot, events: false, autoName: "yes" });
    check("a non-boolean autoName is refused as bad-request and launches nothing",
      (loose as { ok?: boolean }).ok === false && JSON.stringify(loose).includes("bad-request") && launches.length === before && !M.agents.has("loose"), loose);
    const once = await spawn("spawn-once", { name: "once", agent: "auto-name-stub", cwd: repoRoot, events: false, prompt: "do one thing", once: {}, autoName: true });
    check("a once spawn with autoName is refused, naming autoName, and launches nothing",
      (once as { ok?: boolean }).ok === false && JSON.stringify(once).includes("autoName") && launches.length === before && !M.agents.has("once"), once);
  }
} catch (e) {
  check(`the suite threw: ${(e as Error).stack ?? (e as Error).message}`, false);
} finally {
  await runnerNc?.drain().catch(() => runnerNc?.close());
  await manager?.stop({ withAgents: true }).catch(() => {});
  await delivery?.stop().catch(() => {});
  await broker.stop().catch(() => {});
  if (prevHome === undefined) delete process.env.COTAL_HOME;
  else process.env.COTAL_HOME = prevHome;
}
finish();
