import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  statSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  isReachable,
  DEFAULT_SERVER,
  createSpaceAuth,
  serverConfig,
  mintCreds,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  newIdentity,
  setupSpaceStreams,
  seedChannelRegistry,
  ensureDefaultDeliveryClass,
  mkSecretDir,
  writeSecretFile,
  type AuthPrepared,
  type SpaceAuth,
  type ChannelRegistryFile,
  type ParsedArgs,
  type FlagSpec,
  type CompletionResult,
} from "@cotal-ai/core";
import {
  assertUserAuthInfo,
  authDir,
  loadSpaceAuth,
  saveSpaceAuth,
  clearCurrent,
  findMesh,
  getCurrent,
  loadMeshes,
  recordMesh,
  removeMesh,
  setCurrent,
  userAuthStateDir,
  type MeshEntry,
  type UserAuthInfo,
} from "@cotal-ai/workspace";
import { ensureAuthService, resolveAuthProvider, stopAuthService } from "../lib/auth-proc.js";
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { renderDetachedSummary } from "../lib/up-report.js";
import { deliveryUp, ensureControlPlane, stopDelivery } from "../lib/delivery-proc.js";
import { managerHasDeliveryMarker, managerUp, stopManager } from "../lib/manager-proc.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { buildLaunchSpec, genRunId, manifestToChannels, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { renderUpPlan, renderInherited, renderWarnings } from "../lib/manifest/render.js";
import { failManifest } from "./topology.js";
import { extensionNames, preflightRuntime } from "../ext-loader.js";
import { completingFlagValue } from "../lib/completion.js";

/** `cotal up` flags — colocated with the command (like `spawnFlags`) so its completion can read them. */
export const upFlags: FlagSpec[] = [
  { name: "server", type: "string", value: "<url>", description: "listen URL override" },
  { name: "host", type: "string", value: "<host>", description: "bind host override" },
  { name: "space", type: "string", value: "<s>", description: "space name (default: the folder's)" },
  { name: "store-dir", type: "string", value: "<dir>", description: "JetStream store directory" },
  { name: "channels", type: "string", value: "<path>", description: "channel-registry seed file (JSON; default .cotal/channels.json)" },
  { name: "open", type: "boolean", description: "unauthenticated dev mesh (no JWT/ACLs)" },
  { name: "user-auth", type: "boolean", description: "per-USER auth: login + bearer through the space's auth service" },
  { name: "idp", type: "string", value: "<url>", description: "with --user-auth: the IdP auth base URL to pin (first enable)" },
  { name: "detach", type: "boolean", description: "run in the background (stop with `cotal down`)" },
  { name: "runtime", type: "string", value: "<name>", description: "agent runtime for the mesh manager (default pty; extension runtimes are explicit-only, see `cotal runtimes`); with -f overrides the manifest's runtime" },
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "launch a whole mesh from a manifest" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
];

/** Completion for `cotal up` — `--runtime <TAB>` offers `pty` + installed runtime providers (the same
 *  offline source `spawn` uses; a <TAB> never imports or probes). Run `cotal runtimes` to also see the
 *  official ones that aren't installed yet. Any other position falls back to the command's flags, the
 *  same set the dispatcher offers for a command with no hook — the hook only ADDS runtime values. */
export function upComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, upFlags);
  if (flag?.name === "runtime")
    return { items: ["pty", ...extensionNames("runtime")].filter((v, i, a) => a.indexOf(v) === i).map((value) => ({ value })), directive: "nofiles" };
  const items = upFlags.map((f) => ({ value: `--${f.name}`, description: f.description }));
  return { items, directive: items.length ? "nofiles" : "default" };
}

export async function up(args: ParsedArgs): Promise<void> {
  const values = args.values as { server?: string; "store-dir"?: string; space?: string; open?: boolean; "user-auth"?: boolean; idp?: string; channels?: string; detach?: boolean; host?: string; runtime?: string; file?: string; "dry-run"?: boolean };
  const wantUser = Boolean(values["user-auth"]);
  // The auth-mode flags contradict each other loudly, never silently (a user-auth space quietly
  // started open would run agents on the wrong identity plane — the exact failure per-user-auth
  // exists to prevent).
  if (wantUser && values.open) {
    console.error(c.red("✗ --user-auth and --open contradict - a user-auth space cannot run unauthenticated"));
    process.exit(1);
  }
  if (values.idp && !wantUser && !values.file) {
    console.error(c.red('✗ --idp is for user-auth spaces; pair it with --user-auth, or set broker.auth: "user" in a manifest'));
    process.exit(1);
  }
  // `up -f cotal.yaml` is a distinct path: bring up a FRESH mesh described by a manifest (broker +
  // channels + booted agents). It owns the whole space; deploying onto a RUNNING mesh is `spawn -f`.
  // CLI flags override the manifest (flag > manifest > default) so the same file runs at a different
  // port / runtime / space / auth without editing it.
  if (values.file) {
    await upManifest(values.file, {
      dryRun: Boolean(values["dry-run"]),
      server: values.server,
      host: values.host,
      space: values.space,
      runtime: values.runtime,
      open: values.open,
      userAuth: wantUser,
      idp: values.idp,
    });
    return;
  }
  // `--runtime <name>` selects the backend the mesh's manager spawns agents through. The `-f` path
  // preflights inside upManifest; the no-manifest path must too, or the flag is silently dropped and
  // the detached manager boots the default pty. Resolve + probe the runtime NOW, in the operator's
  // process, so an uninstalled/unreachable runtime fails loud HERE (with the `cotal ext add`
  // recourse) instead of a silent fallback in a detached child. No fallbacks. (`pty`/unset: no-op.)
  if (values.runtime) await preflightRuntime(values.runtime);
  let server = values.server ?? DEFAULT_SERVER;
  const host = values.host ?? "127.0.0.1";
  if (await isReachable(server)) {
    const space = values.space ?? resolveSpace(process.cwd());
    const root = cotalRoot();
    // A broker is already on this port. Same root means "this project is already up" unless the
    // operator explicitly asked for a second space in the same `.cotal/` root (unsupported today: pid,
    // auth, and logs are root-scoped). Different root / unrecorded broker on the implicit default port
    // gets a fresh free port instead of making the user hunt for one.
    const held = loadMeshes().find((m) => m.server === server);
    if (held && held.root === root && (held.space === space || values.space === undefined)) {
      // A refresh of the SAME already-running mesh — its mode is fixed by how the live broker was
      // started. A flag asking for a DIFFERENT mode must fail loud (silently preserving the old
      // mode would hand the operator a mesh on the wrong identity plane); a bare refresh keeps the
      // held mode.
      const requested = wantUser ? "user" : values.open ? "open" : undefined;
      if (requested && requested !== held.mode) {
        const label = { auth: "static JWT auth", open: "no auth (--open)", user: "per-user auth" }[held.mode];
        console.error(
          c.red(
            `✗ mesh "${held.space}" is already running at ${server} with ${label} - a running broker can't change auth mode; \`cotal down\` it first, then \`cotal up ${wantUser ? "--user-auth" : "--open"}\``,
          ),
        );
        process.exit(1);
      }
      console.log(c.green(`✓ mesh "${held.space}" already running at ${server}`));
      // USER MODE: re-upping IS the documented recovery for a dead auth service (the provider's
      // failure copy says "restart it with `cotal up`"), so a refresh must re-ensure the service —
      // never just reprint "already running" over a dead callout. No broker config is (re)written
      // here, so healing on a bare `cotal up` is safe: the mode can't drift, only the daemon heals.
      let userAuth = held.userAuth;
      if (held.mode === "user") {
        const auth = loadSpaceAuth(authDir(root));
        if (!auth) {
          console.error(c.red(`✗ mesh "${held.space}" is user-auth but this root has no trust material under ${authDir(root)} - \`cotal down\` it, restore or re-provision \`.cotal/auth\`, then \`cotal up --user-auth\``));
          process.exit(1);
        }
        const stateDir = userAuthStateDir(root, held.space);
        let prepared: AuthPrepared;
        try {
          prepared = await resolveAuthProvider().prepareServer({
            space: held.space,
            operatorSeed: auth.operator.seed,
            account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
            dir: stateDir,
            idpUrl: values.idp,
          });
        } catch (e) {
          console.error(c.red(`✗ ${(e as Error).message}`));
          process.exit(1);
        }
        const svc = await startUserAuthService(held.space, server, { prepared, stateDir });
        userAuth = svc.userAuth;
        // The refresh IS the recovery command — a heal that didn't heal must not exit 0.
        if (!svc.ok) process.exitCode = 1;
      }
      // Auth/user meshes also need their resident renewal owner. A same-root refresh is the normal
      // repair command after a stale/missing manager, so ensure the delivery daemon + manager before
      // claiming the running mesh is healthy. Open meshes have no auth creds or delivery daemon.
      // Re-ensure the control plane on a refresh. The manager is ensured for every mode that reaches
      // here (a heal after a dead/missing manager adopts `--runtime`); the delivery daemon self-gates
      // to auth mode inside `ensureControlPlane`. Open meshes normally skip this (a bare refresh has
      // nothing to heal that must be touched), but a `--runtime` request must be honored there too,
      // not silently dropped.
      if (held.mode !== "open" || values.runtime) {
        // Warn only when the manager is genuinely REUSED: a live delivery-aware (this-build) manager
        // is kept as-is by `ensureManager`, so its runtime can't change. An old hosting manager (no
        // delivery marker) is stopped and REPLACED by the ensure below carrying the requested runtime,
        // so that's not a reuse - don't claim the runtime is fixed. A dead/absent manager is (re)started
        // with it.
        if (values.runtime && managerUp() && managerHasDeliveryMarker())
          console.error(
            c.dim(`! manager already running for "${held.space}" - its runtime is fixed at start; \`cotal down\` then \`cotal up --runtime ${values.runtime}\` to change it`),
          );
        const controlPlane = await startDeliveryWithBroker(held.space, server, { runtime: values.runtime });
        if (!controlPlane) process.exitCode = 1;
      }
      recordOurMesh({ space: held.space, server, root, mode: held.mode, ...(userAuth ? { userAuth } : {}), ts: new Date().toISOString() });
      return;
    }
    const who = held ? `mesh "${held.space}" (${held.root})` : "a broker not started here";
    if (values.server === undefined && (!held || held.root !== root)) {
      const next = await serverWithFreePort(server, host);
      console.log(c.dim(`${server} is already in use by ${who}; starting "${space}" at ${next} instead`));
      server = next;
    } else {
      console.error(
        c.red(
          `✗ ${server} is already in use by ${who} - to run "${space}" use \`--server nats://${host}:<port>\` with a free port`,
        ),
      );
      process.exit(1);
    }
  }

  if (values.detach) {
    const { pid, source, authService, delivery, manager } = await startMeshDetached({
      server,
      storeDir: values["store-dir"],
      space: values.space,
      open: values.open,
      userAuth: wantUser ? { idpUrl: values.idp } : undefined,
      channels: values.channels,
      host,
      runtime: values.runtime,
    });
    console.log(c.dim(`Started nats-server (${source}).`));
    console.log(c.green(renderDetachedSummary({ pid, delivery, authService: wantUser && authService, manager })));
    // A user mesh whose auth service never became ready is recorded + running (a re-`cotal up`
    // heals it), but this `up` did NOT deliver what was asked — automation must see that in the
    // exit code, not only in the red line above.
    if (!authService) process.exitCode = 1;
    return;
  }

  const useAuth = !values.open;
  const space = values.space ?? resolveSpace(process.cwd());
  ensureRootForSpace(useAuth, space); // may pin the cwd as this space's root — before any cotalPath use
  refuseOpenOverUserState(Boolean(values.open), space);
  const storeDir = values["store-dir"] ? resolve(values["store-dir"]) : cotalPath("nats");
  mkdirSync(storeDir, { recursive: true });
  await claimSpace(space, server, cotalRoot());
  const seedFile = loadChannelsFile(values.channels);
  const setup = useAuth ? await authSetup(storeDir, server, space, host, wantUser ? { idpUrl: values.idp } : undefined) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const natsArgs = setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port), "-a", host];
  const { bin, source } = await resolveNatsServer();

  console.log(
    c.dim(
      `Starting nats-server (JetStream, ${useAuth ? "JWT auth" : "OPEN/no-auth"}, ${source}) - store: ${storeDir}, bind: ${host}`,
    ),
  );
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const child = spawn(bin, natsArgs, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    process.exit(1);
  });
  // The control plane is coupled to the broker: stop the delivery daemon AND the detached manager
  // (AND the space's user-auth service) when this `up` stops (Ctrl-C), so none outlives the broker
  // it serves — a surviving manager would reconnect-loop invisibly against the dead (or the NEXT)
  // broker (the documented orphan-supervisor failure mode). All kill by pidfile, symmetric; the
  // auth service's pid is space-scoped so no other space's daemon can ever be hit.
  const stop = () => { stopDelivery(); stopManager(); stopAuthService(space); child.kill("SIGTERM"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // The broker is gone — drop it from the registry (and the `current` pointer if it was the default)
  // so a later `cotal spawn` doesn't try to join a dead mesh.
  child.on("exit", (code) => {
    stopDelivery();
    stopManager();
    stopAuthService(space);
    // Only unrecord if the registry still points at THIS broker. A newer broker for the same space
    // (a concurrent `up`, or a different-port re-up that recorded after us) may have replaced our
    // record — removing by name would clobber the live winner and hide it from the registry.
    const mine = findMesh(space);
    if (mine && mine.server === server && mine.root === cotalRoot()) {
      removeMesh(space);
      if (getCurrent() === space) clearCurrent();
    }
    process.exit(code ?? 0);
  });

  if (await waitReady(server, setup?.creds)) {
    await postStart(server, space, setup, seedFile);
    // USER MODE: the auth service comes up FIRST among the daemons — until its callout answers,
    // every user-mode connect to this broker is denied, so `up` must not report a usable user mesh
    // (nor let agents race it) on a half-started auth plane. (Foreground `up` doesn't exit here, so
    // `ok` has no exit code to carry — the red consequence line above is the operator signal.)
    const svc = await startUserAuthService(space, server, setup);
    // Record BEFORE the control plane comes up: the manager's fail-closed mode detection requires
    // an authoritative registry entry (marker-without-registry is a refused start, not a guess),
    // so the record must exist by the time it boots. A manager/delivery failure after this leaves
    // a recorded-but-degraded mesh — the documented, healable posture.
    recordOurMesh({
      space, server, root: cotalRoot(),
      mode: setup?.prepared ? "user" : useAuth ? "auth" : "open",
      ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
      ts: new Date().toISOString(),
    });
    // Bring up the delivery daemon WITH the server (auth mode only — it self-gates on `.cotal/auth`).
    // It is part of the server, so `cotal up` starts it by default; open dev mode has no daemon.
    // Class-2 credential renewal is NOT wired here: the MANAGER is the renewal owner (it is resident
    // in every mesh mode — foreground, --detach, refresh — where this foreground process is not).
    await startDeliveryWithBroker(space, server, { runtime: values.runtime });
  }
  await new Promise<void>(() => {});
}

/** Bring the space's USER-AUTH service up with the broker (user mode only — `setup.prepared` is the
 *  provider's output). Loud both ways (U5): a ready service prints the login line; a service that
 *  never became ready prints the exact consequence + recourse. Returns the registry metadata either
 *  way — the mesh IS a user-auth mesh even while its service is down (connects must say "auth
 *  service down", never fall back to static semantics) — plus `ok`, so the exiting `up` surfaces
 *  (detach / manifest / refresh-heal) turn a dead identity plane into a NON-ZERO exit: automation
 *  must not read "user mesh up" from a mesh whose every user connect will be denied. */
async function startUserAuthService(
  space: string,
  server: string,
  setup?: { prepared?: AuthPrepared; stateDir?: string },
): Promise<{ userAuth?: UserAuthInfo; ok: boolean }> {
  if (!setup?.prepared || !setup.stateDir) return { ok: true };
  try {
    const endpoints = await ensureAuthService({ space, server, stateDir: setup.stateDir, prepared: setup.prepared });
    const info = assertUserAuthInfo({ ...setup.prepared.publicAuth, endpoints });
    console.log(c.green("✓ user-auth service up") + c.dim(` - sign in with: cotal login --idp ${info.idp.url}`));
    return { userAuth: info, ok: true };
  } catch (e) {
    console.error(c.red(`✗ user-auth service did not come up (${(e as Error).message}) - user connects to "${space}" will fail until a re-\`cotal up\` succeeds`));
    return { userAuth: assertUserAuthInfo(setup.prepared.publicAuth), ok: false };
  }
}

/** `cotal up -f cotal.yaml` — bring up a FRESH mesh from a manifest (broker + channels + booted
 *  agents). `up -f` is a broker-CREATION command: `broker.servers` is the bind address for the NEW
 *  local broker, never a connect target. A broker already reachable there (local OR remote) means
 *  "deploy onto it" — refuse and redirect to `spawn -f`; an unbindable/remote address makes the
 *  broker fail to start (no silent local fallback). It owns the whole space, so `cotal down` tears it
 *  down and no ownership ledger is needed (that's `spawn -f`). */
async function upManifest(file: string, opts: UpManifestFlags): Promise<void> {
  let prepared: PreparedManifest;
  try {
    prepared = loadManifest(resolve(file));
  } catch (e) {
    failManifest(e);
  }
  // The auth-mode sources (flags vs manifest) must AGREE — any mismatch names both sources and the
  // exact correction in one sentence (a no-fallback identity decision, never a bare enum error).
  const declared = prepared.manifest.broker?.auth;
  const declaredStr = declared === undefined ? '"static" (the unset default)' : JSON.stringify(declared);
  if (opts.open && declared === "user") {
    console.error(c.red('✗ --open contradicts this manifest\'s broker.auth: "user" - a user-auth space cannot run unauthenticated. Drop --open, or change the manifest.'));
    process.exit(1);
  }
  if (opts.userAuth && declared !== "user") {
    console.error(c.red(`✗ --user-auth requires manifest broker.auth: "user" (this manifest's broker.auth is ${declaredStr}). Either set broker.auth: "user" in the manifest, or drop --user-auth.`));
    process.exit(1);
  }
  if (opts.idp && declared !== "user") {
    console.error(c.red(`✗ --idp is for user-auth spaces (this manifest's broker.auth is ${declaredStr}) - set broker.auth: "user" in the manifest, or drop --idp.`));
    process.exit(1);
  }
  // Apply CLI overrides to one effective manifest (flag > manifest > default) so render + seed +
  // broker + launch all agree on the same values.
  const eff = applyUpOverrides(prepared, opts);
  const m = eff.manifest;
  const server = m.broker?.servers ?? DEFAULT_SERVER;
  const host = m.broker?.host ?? "127.0.0.1";
  const open = m.broker?.auth === false; // default is auth
  const userAuth = m.broker?.auth === "user" ? { idpUrl: opts.idp ?? m.broker?.idp } : undefined; // flag > manifest
  const runtime = m.runtime ?? "pty";

  if (opts.dryRun) {
    console.log(renderUpPlan(eff, server));
    return;
  }

  // Preflight an extension runtime before starting the broker. The detached manager re-execs this
  // CLI and resolves the same installed package when `supervise --runtime <name>` starts.
  await preflightRuntime(runtime);

  // up -f never adopts a running broker. Reachable at the bind address ⇒ redirect to spawn -f.
  if (await isReachable(server)) {
    console.error(c.red(`✗ ${server} already has a broker - deploy this manifest onto it with \`cotal spawn -f ${file}\``));
    process.exit(1);
  }
  // Connectors + their required binaries must exist before any mutation (no fallback).
  const conn = preflightConnectors(prepared);
  if (conn) {
    console.error(c.red(`✗ connector preflight failed: ${conn}`));
    process.exit(1);
  }

  // USER-AUTH manifest: the agents run under the LOGGED-IN operator's owner, and the launch spec
  // (consumed by the manager at boot) must carry it — so resolve it NOW. On a fresh mesh the
  // derivation material doesn't exist yet; ensure it just-in-time (authSetup + prepareServer are
  // idempotent ensure-* — the same contract the refresh-heal path already rides). Not logged in /
  // no provider = the exact recovery sentence, before anything boots.
  let owner: string | undefined;
  if (userAuth) {
    try {
      mkdirSync(cotalPath("nats"), { recursive: true });
      const setup = await authSetup(cotalPath("nats"), server, m.space, host, userAuth);
      owner = await resolveAuthProvider().ownerForLogin({ dir: setup.stateDir!, space: m.space });
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }
  // The resolved launch spec is written FIRST so the ONE control-plane manager that comes up with
  // the broker (inside startMeshDetached) carries it. Exactly one manager serves a space (the
  // singleton lease): a second `supervise` started here for the launch would race the plain one for
  // the lease — the loser refuses, so either the agents never boot or the incumbent is orphaned
  // behind an overwritten pid file. The manager materializes each transient persona and mints creds
  // from the resolved policy — never re-reading a file for authority.
  const specPath = writeLaunchSpec(cotalRoot(), buildLaunchSpec(eff, genRunId(), owner));
  // A leftover detached manager (its broker is gone — the reachability check above proved nothing
  // lives at this address) would win the fresh mesh's lease and the launch manager would refuse.
  // Stop it, so the manager started below WITH the launch spec is THE manager.
  stopManager();
  let pid: number;
  let controlPlane = false;
  let authService = true;
  try {
    ({ pid, controlPlane, authService } = await startMeshDetached({ server, space: m.space, open, userAuth, host, seed: manifestToChannels(eff), runtime, launch: specPath }));
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  console.log(c.green(`✓ mesh "${m.space}" up at ${server}`) + c.dim(` (broker pid ${pid})`));
  console.log(c.dim(`  seeded ${m.channels.length} channel(s): ${m.channels.map((ch) => "#" + ch.name).join(", ")}`));
  // Never claim a launch the control plane can't deliver: the manager carries the launch spec, so a
  // degraded control plane (announced above) means the agents are NOT coming up.
  if (controlPlane) {
    // U6: on a user mesh the agents run under the OPERATOR's identity — say whose they are.
    console.log(c.green(`✓ launching ${eff.agents.length} agent(s)`) + c.dim(` via manager (${runtime})${owner ? ` as you (owner ${owner})` : ""} - see .cotal/manager.log`));
  } else {
    console.error(c.red(`✗ ${eff.agents.length} agent(s) NOT launched - the control plane did not come up (see above)`));
  }

  // Loud summary: any persona-inherited access an `include` manifest dragged in, plus warnings.
  const inherited = renderInherited(eff);
  if (inherited) console.log("\n" + inherited);
  if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  console.log(c.dim(`\nWatch: \`cotal console --space ${m.space}\` or \`cotal web\`   ·   Tear down: \`cotal down\``));
  // A declared-user-auth manifest whose auth service never became ready: the mesh is up + recorded
  // (re-`cotal up` heals), but this launch did not deliver a usable identity plane — exit non-zero
  // so CI/wrappers don't read success (the red consequence line printed at the failure above).
  if (!authService) process.exitCode = 1;
}

/** CLI overrides for `up -f` — each wins over the manifest's own value (flag > manifest > default).
 *  `userAuth`/`idp` are consistency ASSERTIONS against the manifest, not overrides: the manifest
 *  declares the auth mode; a disagreeing flag is a hard error, never a silent re-mode. */
interface UpManifestFlags {
  dryRun: boolean;
  server?: string;
  host?: string;
  space?: string;
  runtime?: string;
  open?: boolean;
  userAuth?: boolean;
  idp?: string;
}

/** Return a copy of the prepared manifest with CLI overrides applied to broker/space/runtime, so the
 *  whole launch (render, seed, broker, manager, launch spec) runs against one effective manifest. */
function applyUpOverrides(prepared: PreparedManifest, o: UpManifestFlags): PreparedManifest {
  const m = prepared.manifest;
  const broker = { ...m.broker };
  if (o.server) broker.servers = o.server;
  if (o.host) broker.host = o.host;
  if (o.open) broker.auth = false;
  return {
    ...prepared,
    manifest: {
      ...m,
      broker: Object.keys(broker).length ? broker : undefined,
      space: o.space ?? m.space,
      runtime: (o.runtime as typeof m.runtime) ?? m.runtime,
    },
  };
}

/** Start the CONTROL PLANE alongside the broker: old-manager preflight → delivery daemon (auth
 *  mode only) → detached manager. `up` is the launching command — since `setup` became
 *  configure-only (stage 2b), the whole local stack comes up HERE, so `spawn --detach` /
 *  cotal_spawn find a manager without any setup side effect. Coupled to the broker by the
 *  daemon's watchdog + the `up`/`down` teardown. `mgr` rides through to the manager start — the
 *  `up -f` path hands THE manager its runtime + resolved launch spec here (one manager per space,
 *  so the launch can never be a second supervise). Returns whether the control plane came up, so a
 *  caller whose output claims a manager (the `up -f` launching line) can tell the truth. */
async function startDeliveryWithBroker(space: string, server: string, mgr?: { runtime?: string; launch?: string }): Promise<boolean> {
  try {
    await ensureControlPlane({ space, server, ...mgr });
    return true;
  } catch (e) {
    // Non-fatal (live messaging is unaffected) — but never SILENT: without the manager,
    // `spawn --detach` / cotal_spawn have no responder, and the operator must hear it here,
    // not as an unexplained "no manager reachable" later.
    console.error(c.dim(`! control plane degraded: ${(e as Error).message} - durable delivery/manager may be down; start one with: cotal supervise`));
    return false;
  }
}

export interface DetachOpts {
  server?: string;
  storeDir?: string;
  space?: string;
  open?: boolean;
  /** USER MODE: enable per-user auth (presence = on; `idpUrl` pins the IdP on first enable). */
  userAuth?: { idpUrl?: string };
  channels?: string;
  host?: string;
  /** Channel-registry seed in memory (the `cotal up -f` manifest path), used instead of reading a
   *  `--channels` file. Takes precedence over {@link channels}. */
  seed?: ChannelRegistryFile;
  /** Live boot lines, tailed from the server's log file (safe for a detached child). */
  onLine?: (line: string) => void;
  /** Manifest launch (`cotal up -f`): the ONE control-plane manager started alongside the broker
   *  carries this runtime + resolved launch-spec path — never a second supervise (singleton lease). */
  runtime?: string;
  launch?: string;
}

/**
 * Start a background nats-server (JetStream), wait until it's reachable, pre-create the
 * space's streams, and leave it running detached (pid in `.cotal/nats.pid`). Used by
 * `up --detach`. When `onLine` is given, boot output is tailed from the
 * log file and forwarded — the child writes to the file (not a pipe), so it survives the
 * parent exiting.
 */
export async function startMeshDetached(
  opts: DetachOpts = {},
): Promise<{ server: string; pid: number; source: string; controlPlane: boolean; authService: boolean; delivery: boolean; manager: boolean }> {
  const server = opts.server ?? DEFAULT_SERVER;
  const useAuth = !opts.open;
  const space = opts.space ?? resolveSpace(process.cwd());
  ensureRootForSpace(useAuth, space); // may pin the cwd as this space's root — before any cotalPath use
  refuseOpenOverUserState(Boolean(opts.open), space);
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : cotalPath("nats");
  mkdirSync(storeDir, { recursive: true });
  await claimSpace(space, server, cotalRoot());
  const seedFile = opts.seed ?? loadChannelsFile(opts.channels);
  const host = opts.host ?? "127.0.0.1";
  const setup = useAuth ? await authSetup(storeDir, server, space, host, opts.userAuth) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const args = setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port), "-a", host];
  const { bin, source } = await resolveNatsServer();

  const logPath = cotalPath("nats.log");
  const startOffset = existsSync(logPath) ? statSync(logPath).size : 0;
  const fd = openSync(logPath, "a");
  const child = spawn(bin, args, { detached: true, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  child.unref();

  let tailing = Boolean(opts.onLine);
  if (opts.onLine) tailLines(logPath, startOffset, opts.onLine, () => !tailing);

  const ready = await waitReady(server, setup?.creds);
  tailing = false;
  if (!ready) {
    child.kill("SIGTERM");
    throw new Error(`nats-server did not become reachable at ${server} - see ${logPath}`);
  }
  writeFileSync(cotalPath("nats.pid"), String(child.pid));
  await postStart(server, space, setup, seedFile);
  // USER MODE: the auth service comes up FIRST among the daemons (see the foreground path).
  const svc = await startUserAuthService(space, server, setup);
  // Record BEFORE the control plane: the manager's fail-closed mode detection needs the
  // authoritative registry entry at boot (marker-without-registry refuses). Detached: the entry
  // outlives this process — `cotal down` removes it.
  recordOurMesh({
    space, server, root: cotalRoot(),
    mode: setup?.prepared ? "user" : useAuth ? "auth" : "open",
    ...(svc.userAuth ? { userAuth: svc.userAuth } : {}),
    ts: new Date().toISOString(),
  });
  // Bring up the delivery daemon WITH the detached broker (auth mode only; `cotal down` tears both down).
  const controlPlane = await startDeliveryWithBroker(space, server, { runtime: opts.runtime, launch: opts.launch });
  return {
    server,
    pid: child.pid ?? 0,
    source,
    controlPlane,
    authService: svc.ok,
    delivery: useAuth && deliveryUp(),
    manager: managerUp(),
  };
}

/** THE FLIP, open-boot edition: `--open` must never boot a credless broker over a root whose
 *  space has user-auth state on disk — that would serve the space's existing JetStream store to
 *  anyone and re-record the mesh "open" over its user entry. The same fail-closed rule authSetup
 *  enforces for static re-ups, applied to the one boot path that skips authSetup entirely. */
function refuseOpenOverUserState(open: boolean, space: string): void {
  if (!open) return;
  const stateDir = userAuthStateDir(cotalRoot(), space);
  if (!existsSync(stateDir)) return;
  console.error(
    c.red(
      `✗ space "${space}" has user auth enabled (state under ${stateDir}) - \`--open\` would serve its streams without auth. Start it with \`cotal up --user-auth\`, or remove that directory deliberately to disable user auth (existing logins/grants die with it)`,
    ),
  );
  process.exit(1);
}

/** Today a root's `.cotal/auth` is created for one space (its account is space-bound), so an
 *  explicit `--space` naming a different space cannot run against this root's trust material — the
 *  registry would point a `spawn --space` at mismatched creds. A mismatch only exists when
 *  `--space` was given (the default IS this root's space): clear intent for a different mesh. When
 *  the root was merely inherited from an ancestor folder (the cwd has no `.cotal` of its own),
 *  honor that intent — make the cwd the new space's own root. Only a folder that itself holds the
 *  other space's material refuses. (When multi-space-per-root lands, that refusal becomes
 *  provision-the-new-space instead.) */
function ensureRootForSpace(useAuth: boolean, space: string): void {
  if (!useAuth) return;
  const root = cotalRoot();
  const existing = loadSpaceAuth(authDir(root));
  if (!existing || existing.space === space) return;
  const cwd = process.cwd();
  if (root !== cwd) {
    mkdirSync(join(cwd, ".cotal"), { recursive: true });
    console.log(c.dim(`nearest mesh root ${root} is space "${existing.space}" - making this folder its own root for "${space}"`));
    return;
  }
  console.error(
    c.red(
      `✗ this folder is the root of space "${existing.space}" (${authDir(root)}), so it can't also run "${space}" - drop \`--space\` to run "${existing.space}", or start "${space}" from a different folder (it becomes that mesh's own root)`,
    ),
  );
  process.exit(1);
}

/** A space name maps to one mesh in the registry (the key `--space`/`use`/`down` act on). Before
 *  starting a broker, refuse to reuse a space already claimed by a DIFFERENT live mesh — a stale/dead
 *  holder is reclaimed. Re-`up`ping the same mesh (same server + root) is a refresh (port-reachable
 *  path). NOTE: this is a best-effort sequential guard — two `cotal up --space X` racing from
 *  different roots within the same instant can both pass the check before either records; that
 *  concurrent case is out of scope (a single-operator CLI action), not synchronized with a lock. */
async function claimSpace(space: string, server: string, root: string): Promise<void> {
  const existing = findMesh(space);
  if (!existing || (existing.server === server && existing.root === root)) return;
  if (await isReachable(existing.server)) {
    console.error(
      c.red(
        `✗ space "${space}" is already in use by a mesh at ${existing.server} (${existing.root}) - pick a different \`--space\`, or \`cotal down\` it first`,
      ),
    );
    process.exit(1);
  }
  removeMesh(space); // the prior holder's broker is gone — reclaim the name
}

/** Record this mesh in the registry, and set it as the `current` default when there's no usable one
 *  — i.e. the first mesh, OR when `current` dangles at a space that's no longer in the registry (a
 *  ghost pointer is not a default). Never silently redirect a `current` that still resolves to a live
 *  mesh; just say another is the default and how to switch. */
function recordOurMesh(m: MeshEntry): void {
  const cur = getCurrent();
  const usableCurrent = cur && findMesh(cur) ? cur : undefined; // compute before recording m
  recordMesh(m);
  if (!usableCurrent) {
    setCurrent(m.space);
    return;
  }
  if (usableCurrent !== m.space)
    console.log(c.dim(`"${m.space}" up; current is still "${usableCurrent}" - \`cotal use ${m.space}\` to switch`));
}

/** Poll a growing log file and forward newly-appended lines until `stopped()` is true. */
function tailLines(path: string, from: number, onLine: (l: string) => void, stopped: () => boolean): void {
  let offset = from;
  const tick = () => {
    if (stopped()) return;
    try {
      const size = statSync(path).size;
      if (size > offset) {
        const fd = openSync(path, "r");
        const buf = Buffer.alloc(size - offset);
        readSync(fd, buf, 0, buf.length, offset);
        closeSync(fd);
        offset = size;
        for (const line of buf.toString("utf8").split("\n")) if (line.trim()) onLine(line);
      }
    } catch {
      // file may not exist yet on the first ticks — keep polling
    }
    setTimeout(tick, 150);
  };
  setTimeout(tick, 150);
}

async function waitReady(server: string, creds?: string): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (await isReachable(server, creds ? { creds } : undefined)) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

async function serverWithFreePort(server: string, host: string): Promise<string> {
  const url = new URL(server);
  url.port = String(await freePort(host));
  return url.toString();
}

function freePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.once("error", reject);
    srv.listen(0, host, () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : undefined;
      srv.close((err) => {
        if (err) reject(err);
        else if (port) resolve(port);
        else reject(new Error("could not allocate a free port"));
      });
    });
  });
}

/** One-time space infrastructure once the server accepts connections: pre-create the space's
 *  streams + KV buckets, and seed the channel registry. Done for BOTH modes — auth needs it
 *  (agents are denied STREAM.CREATE), and open needs it too so anything that touches a stream
 *  before an endpoint has joined (e.g. `cotal spawn`'s DM-inbox provisioning, `cotal_purge`,
 *  `history clear`) finds the streams instead of failing with StreamNotFound. Open connects
 *  without creds (no authenticator). */
async function postStart(
  server: string,
  space: string,
  setup?: { creds: string },
  seedFile?: ChannelRegistryFile,
): Promise<void> {
  await setupSpaceStreams({ servers: server, space, creds: setup?.creds });
  if (seedFile) {
    await seedChannelRegistry({ servers: server, space, creds: setup?.creds, file: seedFile });
  }
  // SPEC §4: `defaults.deliveryClass` MUST be written at space creation so the effective default is
  // discoverable on the wire, never inferred from the `?? "durable"` resolution fallback. Auth mode
  // (`setup` present ⇒ the delivery daemon is up) is local/self-hosted ⇒ `durable`; open mode has no
  // daemon and is live-only ⇒ `live`. Runs after the seed so an explicit `channels.json` default wins.
  await ensureDefaultDeliveryClass({
    servers: server,
    space,
    creds: setup?.creds,
    deliveryClass: setup ? "durable" : "live",
  });
}

/** Load the declarative channels-config file to seed the registry. An explicit `--channels`
 *  path that's missing is a hard error; the default `.cotal/channels.json` is optional (absent
 *  ⇒ nothing to seed). */
function loadChannelsFile(explicit?: string): ChannelRegistryFile | undefined {
  const path = explicit ? resolve(explicit) : cotalPath("channels.json");
  if (!existsSync(path)) {
    if (explicit) {
      console.error(c.red(`channels file not found: ${path}`));
      process.exit(1);
    }
    return undefined;
  }
  return JSON.parse(readFileSync(path, "utf8")) as ChannelRegistryFile;
}

/** Ensure the space's trust material exists, render a server config, and mint a privileged
 *  setup creds (used to pre-create streams once the server is up). The account signing key
 *  in `.cotal/auth` is what `cotal mint` and the manager later use to issue per-agent creds.
 *
 *  USER MODE (`user` set): additionally run the registered auth provider's `prepareServer` over the
 *  SPACE-SCOPED state dir (`.cotal/auth/<space>/` — the multi-space-ready layout; nothing user-auth
 *  lives flat) and preload its extra account(s) into the broker config. The inverse is fail-closed:
 *  a space whose user-auth state exists MUST keep being started with --user-auth — regenerating the
 *  config without the callout account would silently break every sentinel connect. */
async function authSetup(
  storeDir: string,
  server: string,
  space: string,
  host: string = "127.0.0.1",
  user?: { idpUrl?: string },
): Promise<{ confPath: string; creds: string; prepared?: AuthPrepared; stateDir?: string }> {
  const dir = authDir(cotalRoot());
  let auth: SpaceAuth | undefined = loadSpaceAuth(dir);
  if (!auth) {
    auth = await createSpaceAuth(space);
    saveSpaceAuth(dir, auth); // strips the $SYS seed on disk, but leaves the in-memory `auth` intact …
    await provisionMembershipCreds(auth); // … so the observer can still be minted here (fresh-space only)
  }
  const stateDir = userAuthStateDir(cotalRoot(), space); // the provider's space-scoped state dir
  if (!user && existsSync(stateDir)) {
    console.error(
      c.red(
        `✗ space "${space}" has user auth enabled (state under ${stateDir}) - start it with \`--user-auth\`, or remove that directory deliberately to disable user auth (existing logins/grants die with it)`,
      ),
    );
    process.exit(1);
  }
  let prepared: AuthPrepared | undefined;
  if (user) {
    // Registry composition: the provider came from the composition root (bin/cotal.ts imports
    // @cotal-ai/auth); this package never imports it. No provider ⇒ resolveAuthProvider throws the
    // exact fix. The narrow input is a capability boundary: operator seed (signs the provider's
    // account once) + the data account's pub/signingSeed (projected for the service's minting duty).
    try {
      prepared = await resolveAuthProvider().prepareServer({
        space,
        operatorSeed: auth.operator.seed,
        account: { pub: auth.account.pub, signingSeed: auth.account.signingSeed },
        dir: stateDir,
        idpUrl: user.idpUrl,
      });
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }
  const port = Number(new URL(server).port) || 4222;
  const confPath = resolve(dir, "server.conf");
  writeFileSync(confPath, serverConfig(auth, { port, storeDir, host, ...(prepared ? { extraAccounts: prepared.extraAccounts } : {}) }));
  // Ephemeral setup cred: used only to probe reachability, pre-create the space streams/buckets
  // (setupSpaceStreams) and seed the channel registry (seedChannelRegistry) — all within the
  // enumerated `provisioner` scope. No broad `manager` residual for the up path.
  const creds = await mintCreds(auth, newIdentity(), "provisioner");
  return { confPath, creds, ...(prepared ? { prepared, stateDir } : {}) };
}

/** Mint the two scoped creds the delivery daemon's membership feed loads (broker-sourced graph
 *  membership), at the FRESH `cotal up` while the in-memory `$SYS` signing seed still exists:
 *   - `membership-observer.creds` — SYSTEM-account CONNZ reader (the only window it can be minted: the
 *     `$SYS` seed is never persisted).
 *   - `membership-rw.creds` — DATA-account members-read + feed-write.
 *   - `membership.json` — the DATA account id (the CONNZ/event subjects pin it; non-secret, but kept
 *     0600 alongside the creds).
 *  All 0600. Best-effort: a failure logs and leaves the feed disabled (the graph degrades to traffic-
 *  only, delivery is untouched). Runs only on a FRESH space (the `if (!auth)` branch); a normal down/up
 *  keeps `.cotal/auth` + these creds and reuses them. A space provisioned before this feature has no
 *  in-memory `$SYS` seed, so it gains membership only when its auth is regenerated (a fresh `.cotal/auth`)
 *  — a documented migration property, not a silent no-op.
 *  Coupling: `cotal clean all` deletes this identity-derived set (removeLocalState in clean.ts) —
 *  a cred added here must be added to that removal list too. */
async function provisionMembershipCreds(auth: SpaceAuth): Promise<void> {
  try {
    const observer = await mintMembershipObserverCreds(auth, newIdentity());
    const rw = await mintCreds(auth, newIdentity(), "membership-rw");
    // D5 slice 4: the KICK-only connection-evictor cred — same mint-only-at-fresh-`up` window as
    // the observer ($SYS seed in memory here). The delivery daemon pairs it with the observer to
    // close a revoked/removed principal's live connections. A space without it degrades to
    // deny-new-only (durable reauth) — surfaced loudly by the removal path, never silent.
    const evictor = await mintConnectionEvictorCreds(auth, newIdentity());
    mkSecretDir(cotalPath()); // harden .cotal/ before the creds land (born under a private ACL, no race)
    writeSecretFile(cotalPath("membership-observer.creds"), observer);
    writeSecretFile(cotalPath("membership-rw.creds"), rw);
    writeSecretFile(cotalPath("connection-evictor.creds"), evictor);
    writeSecretFile(cotalPath("membership.json"), JSON.stringify({ accountId: auth.account.pub }));
  } catch (e) {
    console.error(c.dim(`• broker-sourced membership not provisioned: ${(e as Error).message}`));
  }
}
