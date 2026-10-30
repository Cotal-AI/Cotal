/**
 * The delegation bound through the SERVED spawn door on a static mesh. `spawn-grant-bound` proves
 * the bound when `startAgent` is handed a caller; this proves the door hands it one. A real manager
 * serves `spawn`, and a real issued agent credential calls it over the broker on the versioned rail,
 * so the caller the bound measures is the one the broker pinned on the request subject. Nothing here
 * builds a caller by hand for the manager.
 *
 * The spawner is minted the way a foreground seat would be once issued: an agent credential with
 * `spawn`, reading and posting `review`, its evidence recorded with no source and a fixed expiry.
 * Run with: pnpm smoke:spawn-grant-door
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  createSpaceAuth,
  invokeCommand,
  mintAcceptedToken,
  mintCreds,
  mintGeneration,
  mintLifecycleUid,
  newIdentity,
  registry,
  resolveService,
  setupSpaceStreams,
  standaloneConnectOpts,
  withIssuerSession,
  DEV_OWNER,
  type Connector,
  type IssuedCaller,
} from "@cotal-ai/core";
import { agentLifecycleSecretFilePaths, authDir, recordMesh, saveSpaceAuth } from "@cotal-ai/workspace";
import { Manager } from "../src/manager.js";
import { MANAGER_ENDPOINT } from "../src/manager-service-contract.js";
import { bootBroker } from "./_boot-broker.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`); }
};

const space = `grant-door-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const { servers: SERVERS, stop: stopBroker } = await bootBroker(auth);
const dir = mkdtempSync(join(tmpdir(), "cotal-grant-door-"));
const prevHome = process.env.COTAL_HOME;
process.env.COTAL_HOME = join(dir, "home");
mkdirSync(process.env.COTAL_HOME, { recursive: true });
const root = join(dir, "ws");
mkdirSync(join(root, ".cotal", "agents"), { recursive: true });
saveSpaceAuth(authDir(root), auth);
recordMesh({ space, server: SERVERS, root, mode: "auth", ts: new Date().toISOString() });
const persona = (file: string, body: string) => writeFileSync(join(root, ".cotal", "agents", `${file}.md`), `---\nname: ${file}\n${body}---\nbody\n`);
persona("inside", "allowSubscribe: [review]\nallowPublish: [review]\n");
persona("reader", "allowSubscribe: [general]\n");

// A seat that stays up and never joins: the cells read the door's answer and the minted seat.
registry.register({
  kind: "connector",
  name: "smoke-door",
  requires: ["node"],
  buildLaunch: () => ({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 60000)"], env: {} }),
} as Connector);

let mgr: InstanceType<typeof Manager> | undefined;
let nc: Awaited<ReturnType<typeof connect>> | undefined;
try {
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  mgr = new Manager({ space, servers: SERVERS, runtime: "pty", workspaceRoot: root });
  await mgr.start();

  const identity = newIdentity();
  const uid = mintLifecycleUid();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const issued = { generation: mintGeneration(expiresAt), acceptedToken: mintAcceptedToken() };
  const creds = await withIssuerSession({ servers: SERVERS, space, auth, tls: false }, (s) =>
    mintCreds(auth, identity, "agent", {
      lifecycleUid: uid,
      expiresAt,
      issued,
      issuance: { mode: "issue", store: s.store, accepted: s.accepted, sources: [] },
      capabilities: ["spawn"],
      allowSubscribe: ["review"],
      allowPublish: ["review"],
    }),
  );
  const caller = { owner: DEV_OWNER, actor: identity.id, uid, generation: issued.generation } as IssuedCaller;
  nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  const svc = await resolveService(nc, space, MANAGER_ENDPOINT, caller, { deadlineMs: 8_000 });
  const spawn = async (name: string): Promise<{ ok: boolean; message: string; outcome?: string }> => {
    try {
      const r = await invokeCommand(nc!, space, svc, "spawn", { name, agent: "smoke-door", events: false }, { deadlineMs: 20_000 });
      const reply = (r as { reply?: { ok?: boolean; error?: { message?: string; outcome?: string } } }).reply;
      return { ok: reply?.ok === true, message: reply?.error?.message ?? "", outcome: reply?.error?.outcome };
    } catch (e) {
      const err = e as { message?: string; outcome?: string };
      return { ok: false, message: err.message ?? String(e), outcome: err.outcome };
    }
  };
  const seats = () => [...(mgr as unknown as { agents: Map<string, { name: string; lifecycleUid: string }> }).agents.values()];

  console.log("served spawn door");
  const wide = await spawn("reader");
  check("a served spawn wider than the spawner is refused at the door, naming the part", !wide.ok && /more than the spawner holds: allowSubscribe general/.test(wide.message), wide);
  check("the refusal says it did not run", wide.outcome === "not-executed", wide);
  check("and allocates no seat", !seats().some((a) => a.name === "reader"), seats().map((a) => a.name));
  const inside = await spawn("inside");
  check("control: a served spawn inside the spawner's grant is accepted", inside.ok, inside);
  // The door replies at acceptance, before provisioning, so the seat appears after the reply.
  for (let i = 0; i < 200 && !seats().some((a) => a.name === "inside"); i++) await new Promise((r) => setTimeout(r, 100));
  const seat = seats().find((a) => a.name === "inside");
  check("control: and its seat was minted", seat !== undefined && existsSync(agentLifecycleSecretFilePaths(root, space, "inside", seat.lifecycleUid).creds), seats().map((a) => a.name));
} finally {
  await nc?.drain().catch(() => nc?.close());
  await mgr?.stop({ withAgents: true }).catch(() => {});
  await stopBroker();
  if (prevHome === undefined) delete process.env.COTAL_HOME; else process.env.COTAL_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nSPAWN-GRANT-DOOR SMOKE ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
