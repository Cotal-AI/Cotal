import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import { Kvm } from "@nats-io/kv";
import {
  isReachable,
  epAuthBucket,
  recordsBucket,
  instancePinnedInstrumentCapabilities,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  standaloneConnectOpts,
  DEFAULT_SERVER,
  DEFAULT_SPACE,
  DEV_OWNER,
  registry,
  type Command,
  type EpCaller,
  type ParsedArgs,
} from "@cotal-ai/core";
import {
  authDir, findCotalRoot, getSpaceAuth, loadManagerInstanceIdentity, soleSpaceOf, workspaceSecretStore,
  MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE,
} from "@cotal-ai/workspace";
import { Manager } from "./manager.js";
import { MANAGER_ENDPOINT } from "./manager-service-contract.js";
import { makeManagerEndpointEvictor } from "./endpoint-evict.js";
import { makeManagerHolderLivenessProbe } from "./holder-liveness.js";
import { GateReconcileRefused, reconcileEndpointGate } from "./reconcile-gate.js";
import { InstanceDeregisterRefused, deregisterEndpointInstance, makeInstanceProbe } from "./deregister-instance.js";
import { loadRoster } from "./roster.js";
import { loadLaunchSpec, materializePersona, launchAgentToStartOpts } from "./launch.js";
import { type RuntimeMode } from "./runtime/index.js";
import { c } from "./ui.js";

type Values = Record<string, string | undefined>;

/**
 * RECORD THIS PROCESS as the running manager, and un-record it on a clean exit.
 *
 * The daemon writes its OWN pid because it is the only participant that knows it. Until now the
 * record was written by whoever SPAWNED a manager (`cotal up`'s detached re-exec), so every other
 * route to a running manager — a container entrypoint, cron, an operator typing `cotal supervise` —
 * left `.cotal/manager.pid` untouched. On a box where a supervisor is respawned by anything but the
 * CLI, the file then holds the pid of a manager that died some time ago while the live one runs
 * unlisted, and every reader of that file is answering about a process that no longer exists.
 *
 * The returned release is pid-CHECKED. A manager that exits must not delete a record that already
 * belongs to its successor (a fast restart writes the new pid before the old process finishes
 * unwinding), so the record is removed only while it still names this process — the same rule the
 * rest of the pidfile contract keeps: never delete a record you cannot prove is yours.
 *
 * A folder with no `.cotal/` is not a workspace and gets no record: creating one here would plant a
 * stray workspace root wherever a manager happened to be started.
 */
function recordManagerPid(root: string): () => void {
  const dir = join(root, ".cotal");
  if (!existsSync(dir)) {
    console.error(c.dim(`• no ${dir} here, so this manager is not recorded in a pidfile (nothing local will find it by pid)`));
    return () => {};
  }
  const pidPath = join(dir, MANAGER_PIDFILE);
  const markerPath = join(dir, MANAGER_DELIVERY_AWARE_MARKER);
  const mine = String(process.pid);
  writeFileSync(pidPath, mine);
  // Written together and removed together: the marker proves the LIVE pid is a non-hosting build,
  // and it is only meaningful while it names that same pid.
  writeFileSync(markerPath, mine);
  return () => {
    for (const p of [markerPath, pidPath]) {
      try {
        if (readFileSync(p, "utf8").trim() === mine) rmSync(p, { force: true });
      } catch {
        /* already gone, or unreadable: leaving a record we cannot prove is ours is the safe error */
      }
    }
  };
}

/** The space to operate on: explicit `--space`, else this folder's `.cotal/auth` space, else the
 *  default — so a manually-run manager matches the folder's mesh instead of assuming the default. */
function spaceFor(v: Values): string {
  return v.space ?? soleSpaceOf(authDir(findCotalRoot())) ?? DEFAULT_SPACE;
}

/** Run a manager daemon in this process (the long-lived supervisor), then block.
 *  `pty` ships with the manager; every other runtime needs a registered provider. The published
 *  CLI lazy-loads installed providers, while library roots import their integrations explicitly.
 *
 *  The operator CLIENTS of this daemon — detached launch (`cotal spawn --detach`), `stop`, `ps`,
 *  `attach` — live in `@cotal-ai/cli` since stage 2a of the CLI rework: they are thin control-plane
 *  request/reply commands, not daemon code. This package registers only the daemon runner. */
// `--runtime` forces the manager runtime; honored only on the `supervise` path (default
// pty). `cmux` gives each teammate its own cmux tab — `cotal supervise --runtime cmux` is
// the cmux-tab manager.
async function runManager(args: ParsedArgs, defaultRuntime: RuntimeMode): Promise<void> {
  const v = args.values as Values;
  let runtime = defaultRuntime;
  if (defaultRuntime === "auto" && v.runtime) {
    runtime = v.runtime as RuntimeMode;
  }
  const space = spaceFor(v);
  const server = v.server ?? DEFAULT_SERVER;
  // Parse the roster + launch spec before touching the network — a malformed file should fail fast,
  // before the manager comes up or any agent is spawned.
  const roster = v.roster ? loadRoster(v.roster) : [];
  const launchSpec = v.launch ? loadLaunchSpec(v.launch) : undefined;
  if (v["resume-attempt"] && (v.roster || v.launch || v.spawn)) {
    console.error(c.red("✗ --resume-attempt cannot be combined with --roster, --launch, or --spawn; retained agents resume only through the attempt-bound admin control op"));
    process.exit(1);
  }
  if (v["resume-commit-token"] && !v["resume-attempt"]) {
    console.error(c.red("✗ --resume-commit-token requires --resume-attempt"));
    process.exit(1);
  }
  if (!(await isReachable(server))) {
    console.error(c.red(`Can't reach NATS at ${server}. Run: cotal up`));
    process.exit(1);
  }
  const consolePort = v["console-port"] ? Number(v["console-port"]) : undefined;
  // P2 item 6: the broker ws listener port (loopback) `cotal up` allocated — the console's mesh
  // session client builds its wsUrl from it. Absent ⇒ no console session client (POST /session 503s).
  const wsPort = v["ws-port"] ? Number(v["ws-port"]) : undefined;
  // Where the console face binds. Absent → loopback, so a bare `cotal supervise` keeps a
  // machine-local console. `cotal up` passes the address it bound the broker to when the operator
  // asked for an exposed console; the terminal itself rides the mesh either way.
  const attachHost = v["console-host"];
  // Construction resolves the runtime (createRuntime) — which fails loud on an unusable env, e.g. the
  // pty runtime under Bun. Render that as one actionable line, not a raw stack (this also lands in
  // `.cotal/manager.log` for a detached `cotal up` daemon).
  let mgr: Manager;
  try {
    // The published-binary supervisor resolves connectors from the operator manifest (seeded +
    // `ext add`ed), NOT from static imports — `bin/cotal.ts` no longer registers any. A direct
    // library `Manager` keeps the registry-only default (opt-in preserved).
    mgr = new Manager({
      space,
      servers: server,
      runtime,
      consolePort,
      wsPort,
      attachHost,
      installedExtensions: true,
      resumeAttemptId: v["resume-attempt"],
      resumeDurableCommitToken: v["resume-commit-token"],
    });
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  await mgr.start();
  // AFTER start, not before: a manager that failed to come up must not leave a record claiming it
  // did. `findCotalRoot` is the same root the Manager itself defaulted to.
  const releasePidRecord = recordManagerPid(findCotalRoot());
  console.log(
    c.green("✓ manager up") +
      c.dim(` (space ${space} · ${mgr.runtimeKind})`) +
      `\n  console: ${mgr.consoleUrl}` +
      c.dim("\n  spawn: cotal spawn --detach <persona>   ·   stop: cotal stop --name <n>   (Ctrl-C to shut down)"),
  );
  // Register shutdown handlers before any spawning, so a Ctrl-C during the (possibly slow,
  // staggered) boot tears the manager and its spawned teammates down rather than orphaning them.
  const shutdown = () => void mgr.stop()
    .then(() => {
      releasePidRecord();
      process.exit(0);
    })
    .catch((e) => {
      process.exitCode = 1;
      // The record is NOT released here: the stop did not complete, so this process may still be
      // running and still holding the control plane. A record removed under a failed stop is the
      // orphan-the-process defect the pidfile contract exists to prevent.
      console.error(c.red(`✗ ${(e as Error).message}`));
    });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // Declarative boot: bring up each rostered agent through the same spawn path as a detached spawn.
  // A failed entry is logged but non-fatal — healthy agents stay up and the operator can
  // fix the roster without the supervisor crash-looping.
  for (const entry of roster) {
    const reply = await mgr.startAgent(entry);
    // Log the spawned IDENTITY (the persona's name:), which can differ from entry.name (the file ref).
    const spawned = (reply.data as { name?: string } | undefined)?.name ?? entry.name;
    if (reply.ok) console.log(c.green(`✓ started ${c.bold(spawned)}`) + c.dim(` (${entry.agent})`));
    else console.error(c.red(`✗ ${entry.name}: ${reply.error}`));
  }
  // Pre-spawn teammates the manager owns (e.g. the demo's david/sven), so they're despawnable.
  // Stagger them: wait for each to register presence before launching the next, so several heavy
  // Claude cold-starts don't boot simultaneously and spike memory. The last one needs no wait.
  if (v.spawn) {
    const names = v.spawn.split(",").map((s) => s.trim()).filter(Boolean);
    for (let i = 0; i < names.length; i++) {
      const ref = names[i];
      const reply = await mgr.startByName(ref);
      if (!reply.ok) {
        console.error(c.red(`✗ couldn't spawn ${ref}: ${reply.error ?? "unknown error"}`));
        continue;
      }
      // The peer joins under its persona's name: (the spawned identity), which may differ from the
      // ref filename — wait on (and log) THAT, or staggering blocks the full timeout on a name that
      // never appears (e.g. ref review-critic → identity socrates).
      const spawned = (reply.data as { name?: string } | undefined)?.name ?? ref;
      console.log(c.green(`✓ spawned ${spawned}`));
      if (i < names.length - 1) {
        const joined = await mgr.waitForPresence(spawned);
        console.log(c.dim(joined ? `  ${spawned} joined; starting next` : `  ${spawned} still starting; continuing`));
      }
    }
  }
  // Declarative manifest boot (`cotal up -f` / `spawn -f`): materialize each resolved agent's
  // transient persona, then spawn it with its resolved ACLs/identity. Staggered like `--spawn` so
  // heavy cold-starts don't pile up. A failed entry is logged, non-fatal — healthy agents stay up.
  if (launchSpec) {
    const root = findCotalRoot();
    for (let i = 0; i < launchSpec.agents.length; i++) {
      const la = launchSpec.agents[i];
      let configPath: string;
      try {
        configPath = materializePersona(root, launchSpec.runId, la);
      } catch (e) {
        console.error(c.red(`✗ ${la.name}: ${(e as Error).message}`));
        continue;
      }
      const reply = await mgr.startAgent(launchAgentToStartOpts(la, configPath, launchSpec.owner, launchSpec.runId));
      if (!reply.ok) {
        console.error(c.red(`✗ ${la.name}: ${reply.error}`));
        continue;
      }
      const spawned = (reply.data as { name?: string } | undefined)?.name ?? la.name;
      console.log(c.green(`✓ launched ${spawned}`) + c.dim(` (${la.agent})`));
      if (i < launchSpec.agents.length - 1) {
        const joined = await mgr.waitForPresence(spawned);
        console.log(c.dim(joined ? `  ${spawned} joined; starting next` : `  ${spawned} still starting; continuing`));
      }
    }
  }
  await new Promise<void>(() => {});
}

/**
 * `cotal reconcile-gate` — the guarded exit from an issuance gate left FROZEN by a crashed
 * re-registration whose freeze-holder is dead (#391).
 *
 * WHY THIS IS A CLI COMMAND AND NOT AN ADMIN VERB ON THE MANAGER ENDPOINT: the wedged state IS
 * "the manager cannot complete registration", so anything the manager endpoint serves is
 * unreachable in exactly the state it would exist to repair. This runs operator-locally against
 * the auth KV and the delivery daemon, needing nothing from the wedged endpoint.
 *
 * Read-only until the guard passes: it observes and probes before it constructs the barrier.
 */
async function runReconcileGate(args: ParsedArgs): Promise<void> {
  const v = args.values as Values;
  const space = spaceFor(v);
  const servers = v.server ?? DEFAULT_SERVER;
  const endpoint = v.endpoint ?? MANAGER_ENDPOINT;
  const root = findCotalRoot();

  // The instanceId is the manager's PERSISTED identity by default — the same one the crashed
  // incarnation registered under. An explicit --instance covers a non-manager endpoint.
  const instanceId = v.instance ?? loadManagerInstanceIdentity(root, space)?.instanceId;
  if (!instanceId)
    throw new Error(`no persisted manager instance identity under ${root} for space "${space}" — pass --instance <id> for a non-manager endpoint`);

  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth)
    throw new Error(`no space auth for "${space}" here — run this on the mesh root that holds the space's auth material`);

  console.error(c.dim(`• reconciling the ${endpoint} issuance gate for ${instanceId} on ${servers} (space ${space})`));

  const identity = newIdentity();
  const creds = await mintCreds(auth, identity, "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint, instanceId },
  });
  const nc = await connect({ servers, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(nc).open(epAuthBucket(space));
    const report = await reconcileEndpointGate({
      kv, space, endpoint, instanceId,
      probeHolder: makeManagerHolderLivenessProbe({ space, servers, auth, log: (l) => console.error(c.dim(`  ${l}`)) }),
      evict: makeManagerEndpointEvictor({ space, servers, auth, log: (l) => console.error(c.dim(`  ${l}`)) }),
      log: (l) => console.error(`  ${l}`),
    });
    console.log(
      c.green(`✓ ${endpoint}/${instanceId}: gate reopened at generation ${report.reopenedAtGeneration}`) +
        ` (processEpoch unchanged at ${report.before.processEpoch}; ${report.revoked.length} credential(s) revoked, ${report.evicted.length} holder(s) verify-evicted). Start the manager to let its normal takeover run.`,
    );
  } catch (e) {
    // A refusal is the DESIGNED outcome for every state this does not repair, so it prints the
    // condition by name — an operator must never have to guess which guard fired.
    if (e instanceof GateReconcileRefused) {
      console.error(c.red(`✗ refused (${e.condition}): ${e.message}`));
      process.exitCode = 2;
      return;
    }
    throw e;
  } finally {
    await nc.drain().catch(() => nc.close());
  }
}

/**
 * `cotal deregister-instance` — remove the service registration of an instance whose host is gone.
 *
 * WHY A LOCAL OPERATOR COMMAND AND NOT AN ADMIN VERB ON THE ENDPOINT: the record to remove belongs
 * to an instance that by definition answers nothing, so there is no one to ask. It runs against the
 * records KV with a credential minted from the space seed on this machine, needing nothing from the
 * dead instance.
 *
 * TWO CREDENTIALS, because they are two different authorities and neither implies the other:
 *  - a `control-caller-privileged` instrument PINNED to the instance, which is what can ask the
 *    instance's own rail whether anything is there (the guard);
 *  - an `endpoint-serve-executor` pinned to the same instance, whose grants name exactly that
 *    registration's two records keys (the delete).
 */
async function runDeregisterInstance(args: ParsedArgs): Promise<void> {
  const v = args.values as Values;
  const space = spaceFor(v);
  const servers = v.server ?? DEFAULT_SERVER;
  const endpoint = v.endpoint ?? MANAGER_ENDPOINT;
  const root = findCotalRoot();

  // Same default as `reconcile-gate`: this folder's own persisted manager instance. A FOREIGN
  // corpse (another machine's instance, the case this exists for) is named explicitly, and `cotal
  // ps` prints the whole id for exactly that.
  const instanceId = v.instance ?? loadManagerInstanceIdentity(root, space)?.instanceId;
  if (!instanceId)
    throw new Error(`no persisted manager instance identity under ${root} for space "${space}" - pass --instance <id> (the whole id, as \`cotal ps\` prints it)`);

  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth)
    throw new Error(`no space auth for "${space}" here - run this on the mesh root that holds the space's auth material`);

  console.error(c.dim(`• deregistering ${endpoint}/${instanceId} on ${servers} (space ${space})`));

  // The GUARD's credential: a one-shot privileged instrument pinned to this one instance, so its
  // describe and its interest probe ride that instance's own `inst` rails and nothing wider.
  const probeIdentity = newIdentity();
  const probeUid = mintLifecycleUid();
  const probeCreds = await mintCreds(auth, probeIdentity, "control-caller-privileged", {
    lifecycleUid: probeUid,
    endpointCapabilities: instancePinnedInstrumentCapabilities("privileged", instanceId),
  });
  const probeCaller: EpCaller = { owner: DEV_OWNER, actor: probeIdentity.id, uid: probeUid };
  const probeNc = await connect({ servers, ...standaloneConnectOpts({ creds: probeCreds, tls: false }), maxReconnectAttempts: 0 });
  const probeInstance = makeInstanceProbe(probeNc, { space, endpoint, instanceId, caller: probeCaller });

  // The DELETE's credential: the executor whose grants name exactly this registration's two
  // records keys. Minted only after the connection above exists, and used only after the guard.
  const execIdentity = newIdentity();
  const execCreds = await mintCreds(auth, execIdentity, "endpoint-serve-executor", {
    endpointServeExecutor: { endpoint, instanceId },
  });
  const execNc = await connect({ servers, ...standaloneConnectOpts({ creds: execCreds, tls: false }), maxReconnectAttempts: 0 });
  try {
    const kv = await new Kvm(execNc).open(recordsBucket(space));
    const report = await deregisterEndpointInstance({
      kv, endpoint, instanceId, probeInstance, log: (l) => console.error(`  ${l}`),
    });
    console.log(
      c.green(`✓ ${endpoint}/${instanceId} deregistered`) +
        ` (spec revision ${report.removedSpecRevision}${report.removedStatusRevision !== undefined ? `, status revision ${report.removedStatusRevision}` : ""}).` +
        ` It is gone from every class scatter in space "${space}"; if that host ever comes back, its manager registers again on start.`,
    );
  } catch (e) {
    // A refusal is the DESIGNED outcome for every state this does not repair, so it prints its
    // condition by name rather than leaving the operator to guess which guard fired.
    if (e instanceof InstanceDeregisterRefused) {
      console.error(c.red(`✗ refused (${e.condition}): ${e.message}`));
      process.exitCode = 2;
      return;
    }
    throw e;
  } finally {
    await execNc.drain().catch(() => execNc.close());
    await probeNc.drain().catch(() => probeNc.close());
  }
}

/** The manager's commands: the `supervise` daemon runner, and the guarded `reconcile-gate` repair.
 *  Self-registered on import; the `cotal` binary resolves them from the registry. */
const managerCommands: Command[] = [
  {
    kind: "command",
    name: "supervise",
    group: "Manager",
    summary:
      "run a manager - [--runtime <name>] (default pty; extension runtimes are explicit-only) [--space <s>] [--server <url>] [--console-port <n>] [--roster <file>] [--launch <spec>] [--resume-attempt <id>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to supervise (default: this folder's auth space)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "runtime", type: "string", value: "<name>", description: "agent runtime (default pty; others come from installed extensions)" },
      { name: "console-port", type: "string", value: "<n>", description: "protocol-console port" },
      { name: "console-host", type: "string", value: "<host>", description: "bind host for the console endpoint (default: loopback)" },
      { name: "ws-port", type: "string", value: "<n>", description: "broker ws listener port for the console session client (P2 item 6)" },
      { name: "roster", type: "string", value: "<file>", description: "declarative roster to boot at startup" },
      { name: "launch", type: "string", value: "<spec>", description: "resolved mesh-manifest launch spec (cotal up -f / spawn -f)" },
      { name: "resume-attempt", type: "string", value: "<id>", description: "maintenance restore attempt accepted by resumePreserved" },
      { name: "resume-commit-token", type: "string", value: "<token>", description: "durable resume commit evidence for crash recovery" },
      { name: "spawn", type: "string", value: "<names>", description: "comma-separated personas to pre-spawn at startup" },
    ],
    requiredExtensions: (args) => {
      const runtime = args.values.runtime;
      return typeof runtime === "string" && runtime !== "pty" ? [{ kind: "runtime", name: runtime }] : [];
    },
    run: (args) => runManager(args, "auto"),
  },
  {
    kind: "command",
    name: "reconcile-gate",
    group: "Manager",
    summary:
      "reconcile an issuance gate left frozen by a crashed re-registration - verifies the freeze-holder is gone, then completes the dead op (refuses if it is alive or unprovable) [--space <s>] [--server <url>] [--endpoint <e>] [--instance <id>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to reconcile in (default: this folder's auth space)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "endpoint", type: "string", value: "<e>", description: `endpoint whose gate is frozen (default: ${MANAGER_ENDPOINT})` },
      { name: "instance", type: "string", value: "<id>", description: "instance id (default: this folder's persisted manager instance)" },
    ],
    run: runReconcileGate,
  },
  {
    kind: "command",
    name: "deregister-instance",
    group: "Manager",
    summary:
      "remove the service registration of an instance whose host is gone - refuses if it answers, so a live one is never removed [--space <s>] [--server <url>] [--endpoint <e>] [--instance <id>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space the instance is registered in (default: this folder's auth space)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL (default: the local mesh)" },
      { name: "endpoint", type: "string", value: "<e>", description: `endpoint the instance serves (default: ${MANAGER_ENDPOINT})` },
      { name: "instance", type: "string", value: "<id>", description: "instance id to deregister, the whole id as `cotal ps` prints it (default: this folder's persisted manager instance)" },
    ],
    run: runDeregisterInstance,
  },
];

registry.register(...managerCommands);
