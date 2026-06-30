import { spawn } from "node:child_process";
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
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  isReachable,
  DEFAULT_SERVER,
  createSpaceAuth,
  serverConfig,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  setupSpaceStreams,
  seedChannelRegistry,
  ensureDefaultDeliveryClass,
  mkSecretDir,
  writeSecretFile,
  type SpaceAuth,
  type ChannelRegistryFile,
} from "@cotal-ai/core";
import {
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
  type MeshEntry,
} from "@cotal-ai/workspace";
import { resolveSpace } from "../lib/status.js";
import { c } from "../ui.js";
import { resolveNatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { ensureDelivery, stopDelivery, stopOldHostingManagerIfPresent } from "../lib/delivery-proc.js";
import { startManagerDetached } from "../lib/manager-proc.js";
import { loadManifest, type PreparedManifest } from "../lib/manifest/index.js";
import { buildLaunchSpec, genRunId, manifestToChannels, preflightConnectors, writeLaunchSpec } from "../lib/manifest/apply.js";
import { renderUpPlan, renderInherited, renderWarnings } from "../lib/manifest/render.js";
import { failManifest } from "./topology.js";

export async function up(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      server: { type: "string" },
      "store-dir": { type: "string" },
      space: { type: "string" },
      open: { type: "boolean" }, // disable auth — run an open dev mesh
      channels: { type: "string" }, // seed the channel registry from this JSON file
      detach: { type: "boolean" }, // run the server in the background (pid in .cotal/nats.pid)
      host: { type: "string" }, // bind address (default 127.0.0.1 — loopback; 0.0.0.0 to expose with auth)
      runtime: { type: "string" }, // with -f: override the manifest's runtime (pty | tmux | cmux)
      file: { type: "string", short: "f" }, // a mesh manifest (cotal.yaml) — fresh broker + channels + agents
      "dry-run": { type: "boolean" }, // with -f: print the plan, mutate nothing
    },
  });
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
    });
    return;
  }
  const server = values.server ?? DEFAULT_SERVER;
  const host = values.host ?? "127.0.0.1";
  if (await isReachable(server)) {
    const space = values.space ?? resolveSpace(process.cwd());
    const root = cotalRoot();
    // A broker is already on this port. Only treat it as a no-op refresh when the registry confirms
    // it's THIS exact mesh (same server + root + space). Anything else — a different space/root, or a
    // broker we never recorded — we must NOT adopt: recording our space over it would let a later
    // `spawn --space <s>` load the wrong root's creds. Today one broker serves one space (auth binds
    // them), so a different space on this port can't be added to it yet — fail loudly and tell the
    // user to free the port. (Hosting several spaces on one broker is the planned multi-space work.)
    const held = loadMeshes().find((m) => m.server === server);
    if (held && held.root === root && held.space === space) {
      // A refresh of the SAME already-running mesh — its mode is fixed by how the live broker was
      // started; preserve `held.mode` rather than relabel it from this invocation's `--open`.
      recordOurMesh({ space, server, root, mode: held.mode, ts: new Date().toISOString() });
      console.log(c.green(`✓ NATS already running at ${server}`));
      return;
    }
    const who = held ? `mesh "${held.space}" (${held.root})` : "a broker not started here";
    console.error(
      c.red(
        `✗ ${server} is already in use by ${who} — to run "${space}" use \`--server nats://${host}:<port>\` with a free port`,
      ),
    );
    process.exit(1);
  }

  if (values.detach) {
    const { pid, source } = await startMeshDetached({
      server,
      storeDir: values["store-dir"],
      space: values.space,
      open: values.open,
      channels: values.channels,
      host,
    });
    console.log(c.dim(`Started nats-server (${source}).`));
    console.log(c.green(`✓ mesh running in the background (pid ${pid}) — stop with: cotal down`));
    return;
  }

  const storeDir = values["store-dir"] ? resolve(values["store-dir"]) : cotalPath("nats");
  mkdirSync(storeDir, { recursive: true });
  const useAuth = !values.open;
  const space = values.space ?? resolveSpace(process.cwd());
  assertAuthMatchesSpace(useAuth, space);
  await claimSpace(space, server, cotalRoot());
  const seedFile = loadChannelsFile(values.channels);
  const setup = useAuth ? await authSetup(storeDir, server, space, host) : undefined;
  const port = Number(new URL(server).port) || 4222;
  const args = setup ? ["-c", setup.confPath] : ["-js", "-sd", storeDir, "-p", String(port), "-a", host];
  const { bin, source } = await resolveNatsServer();

  console.log(
    c.dim(
      `Starting nats-server (JetStream, ${useAuth ? "JWT auth" : "OPEN/no-auth"}, ${source}) — store: ${storeDir}, bind: ${host}`,
    ),
  );
  console.log(c.dim("Press Ctrl-C to stop.\n"));
  const child = spawn(bin, args, { stdio: "inherit" });
  child.on("error", (err) => {
    console.error(c.red(`Failed to start nats-server: ${err.message}`));
    process.exit(1);
  });
  // The delivery daemon is coupled to the broker: stop it when this `up` stops (Ctrl-C), so the daemon
  // never outlives the broker it serves.
  const stop = () => { stopDelivery(); child.kill("SIGTERM"); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // The broker is gone — drop it from the registry (and the `current` pointer if it was the default)
  // so a later `cotal spawn` doesn't try to join a dead mesh.
  child.on("exit", (code) => {
    stopDelivery();
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
    // Bring up the delivery daemon WITH the server (auth mode only — it self-gates on `.cotal/auth`).
    // It is part of the server, so `cotal up` starts it by default; open dev mode has no daemon.
    await startDeliveryWithBroker(space, server);
    recordOurMesh({ space, server, root: cotalRoot(), mode: useAuth ? "auth" : "open", ts: new Date().toISOString() });
  }
  await new Promise<void>(() => {});
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
  if (opts.runtime && !["pty", "tmux", "cmux"].includes(opts.runtime)) {
    console.error(c.red(`✗ unknown --runtime "${opts.runtime}" — expected pty, tmux, or cmux`));
    process.exit(1);
  }
  // Apply CLI overrides to one effective manifest (flag > manifest > default) so render + seed +
  // broker + launch all agree on the same values.
  const eff = applyUpOverrides(prepared, opts);
  const m = eff.manifest;
  const server = m.broker?.servers ?? DEFAULT_SERVER;
  const host = m.broker?.host ?? "127.0.0.1";
  const open = m.broker?.auth === false; // default is auth
  const runtime = m.runtime ?? "pty";

  if (opts.dryRun) {
    console.log(renderUpPlan(eff, server));
    return;
  }

  // up -f never adopts a running broker. Reachable at the bind address ⇒ redirect to spawn -f.
  if (await isReachable(server)) {
    console.error(c.red(`✗ ${server} already has a broker — deploy this manifest onto it with \`cotal spawn -f ${file}\``));
    process.exit(1);
  }
  // Connectors + their required binaries must exist before any mutation (no fallback).
  const conn = preflightConnectors(prepared);
  if (conn) {
    console.error(c.red(`✗ connector preflight failed: ${conn}`));
    process.exit(1);
  }

  // 1) fresh broker + space streams + channels seeded from the manifest (in-memory seed).
  let pid: number;
  try {
    ({ pid } = await startMeshDetached({ server, space: m.space, open, host, seed: manifestToChannels(eff) }));
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  console.log(c.green(`✓ mesh "${m.space}" up at ${server}`) + c.dim(` (broker pid ${pid})`));
  console.log(c.dim(`  seeded ${m.channels.length} channel(s): ${m.channels.map((ch) => "#" + ch.name).join(", ")}`));

  // 2) write the resolved launch spec + boot agents through a manager (it materializes each transient
  //    persona and mints creds from the resolved policy — never re-reading a file for authority).
  const specPath = writeLaunchSpec(cotalRoot(), buildLaunchSpec(eff, genRunId()));
  startManagerDetached({ space: m.space, server, runtime, launch: specPath });
  console.log(c.green(`✓ launching ${eff.agents.length} agent(s)`) + c.dim(` via manager (${runtime}) — see .cotal/manager.log`));

  // Loud summary: any persona-inherited access an `include` manifest dragged in, plus warnings.
  const inherited = renderInherited(eff);
  if (inherited) console.log("\n" + inherited);
  if (eff.warnings.length) console.log("\n" + renderWarnings(eff.warnings));
  console.log(c.dim(`\nWatch: \`cotal console --space ${m.space}\` or \`cotal web\`   ·   Tear down: \`cotal down\``));
}

/** CLI overrides for `up -f` — each wins over the manifest's own value (flag > manifest > default). */
interface UpManifestFlags {
  dryRun: boolean;
  server?: string;
  host?: string;
  space?: string;
  runtime?: string;
  open?: boolean;
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

/** Start the server-side delivery daemon alongside the broker (auth mode only): old-manager preflight
 *  first (so an old hosting manager can't double-bind), then the auth-gated daemon (a no-op in open
 *  mode). Coupled to the broker by the daemon's own broker-gone watchdog + the `up`/`down` teardown. */
async function startDeliveryWithBroker(space: string, server: string): Promise<void> {
  try {
    stopOldHostingManagerIfPresent();
    await ensureDelivery({ space, server });
  } catch {
    /* non-fatal — durable delivery degrades, live delivery is unaffected */
  }
}

export interface DetachOpts {
  server?: string;
  storeDir?: string;
  space?: string;
  open?: boolean;
  channels?: string;
  host?: string;
  /** Channel-registry seed in memory (the `cotal up -f` manifest path), used instead of reading a
   *  `--channels` file. Takes precedence over {@link channels}. */
  seed?: ChannelRegistryFile;
  /** Live boot lines, tailed from the server's log file (safe for a detached child). */
  onLine?: (line: string) => void;
}

/**
 * Start a background nats-server (JetStream), wait until it's reachable, pre-create the
 * space's streams, and leave it running detached (pid in `.cotal/nats.pid`). Shared by
 * `up --detach` and `cotal setup`. When `onLine` is given, boot output is tailed from the
 * log file and forwarded — the child writes to the file (not a pipe), so it survives the
 * parent exiting.
 */
export async function startMeshDetached(opts: DetachOpts = {}): Promise<{ server: string; pid: number; source: string }> {
  const server = opts.server ?? DEFAULT_SERVER;
  const storeDir = opts.storeDir ? resolve(opts.storeDir) : cotalPath("nats");
  mkdirSync(storeDir, { recursive: true });
  const useAuth = !opts.open;
  const space = opts.space ?? resolveSpace(process.cwd());
  assertAuthMatchesSpace(useAuth, space);
  await claimSpace(space, server, cotalRoot());
  const seedFile = opts.seed ?? loadChannelsFile(opts.channels);
  const host = opts.host ?? "127.0.0.1";
  const setup = useAuth ? await authSetup(storeDir, server, space, host) : undefined;
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
    throw new Error(`nats-server did not become reachable at ${server} — see ${logPath}`);
  }
  writeFileSync(cotalPath("nats.pid"), String(child.pid));
  await postStart(server, space, setup, seedFile);
  // Bring up the delivery daemon WITH the detached broker (auth mode only; `cotal down` tears both down).
  await startDeliveryWithBroker(space, server);
  // Detached: the registry entry outlives this process — `cotal down` removes it.
  recordOurMesh({ space, server, root: cotalRoot(), mode: useAuth ? "auth" : "open", ts: new Date().toISOString() });
  return { server, pid: child.pid ?? 0, source };
}

/** Today a root's `.cotal/auth` is created for one space (its account is space-bound), so starting it
 *  under a *different* explicit `--space` would run that space's name against the other space's trust
 *  material — the registry would then point a `spawn --space` at mismatched creds. Reject it. (When
 *  multi-space-per-root lands, this becomes provision-the-new-space instead of an error.) */
function assertAuthMatchesSpace(useAuth: boolean, space: string): void {
  if (!useAuth) return;
  const existing = loadSpaceAuth(authDir(cotalRoot()));
  if (existing && existing.space !== space) {
    console.error(
      c.red(
        `✗ this root's trust material is for space "${existing.space}", not "${space}" — drop \`--space\` (it defaults to "${existing.space}"), or run "${space}" from its own root`,
      ),
    );
    process.exit(1);
  }
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
        `✗ space "${space}" is already in use by a mesh at ${existing.server} (${existing.root}) — pick a different \`--space\`, or \`cotal down\` it first`,
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
    console.log(c.dim(`"${m.space}" up; current is still "${usableCurrent}" — \`cotal use ${m.space}\` to switch`));
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
 *  in `.cotal/auth` is what `cotal mint` and the manager later use to issue per-agent creds. */
async function authSetup(
  storeDir: string,
  server: string,
  space: string,
  host: string = "127.0.0.1",
): Promise<{ confPath: string; creds: string }> {
  const dir = authDir(cotalRoot());
  let auth: SpaceAuth | undefined = loadSpaceAuth(dir);
  if (!auth) {
    auth = await createSpaceAuth(space);
    saveSpaceAuth(dir, auth); // strips the $SYS seed on disk, but leaves the in-memory `auth` intact …
    await provisionMembershipCreds(auth); // … so the observer can still be minted here (fresh-space only)
  }
  const port = Number(new URL(server).port) || 4222;
  const confPath = resolve(dir, "server.conf");
  writeFileSync(confPath, serverConfig(auth, { port, storeDir, host }));
  const creds = await mintCreds(auth, newIdentity(), "manager"); // privileged, ephemeral
  return { confPath, creds };
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
 *  — a documented migration property, not a silent no-op. */
async function provisionMembershipCreds(auth: SpaceAuth): Promise<void> {
  try {
    const observer = await mintMembershipObserverCreds(auth, newIdentity());
    const rw = await mintCreds(auth, newIdentity(), "membership-rw");
    mkSecretDir(cotalPath()); // harden .cotal/ before the creds land (born under a private ACL, no race)
    writeSecretFile(cotalPath("membership-observer.creds"), observer);
    writeSecretFile(cotalPath("membership-rw.creds"), rw);
    writeSecretFile(cotalPath("membership.json"), JSON.stringify({ accountId: auth.account.pub }));
  } catch (e) {
    console.error(c.dim(`• broker-sourced membership not provisioned: ${(e as Error).message}`));
  }
}
