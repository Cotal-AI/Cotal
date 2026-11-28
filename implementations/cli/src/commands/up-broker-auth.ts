import {
  drainAndClose,
  isReachable,
  dialerFor,
  createSpaceAuth,
  applyAccountLimits,
  decodeNatsJwt,
  type AccountLimits,
  loadAccountLimits,
  serverConfig,
  openServerConfig,
  type BrokerTransport,
  credsProblem,
  mintCreds,
  mintConnectionEvictorCreds,
  mintMembershipObserverCreds,
  newIdentity,
  standaloneConnectOpts,
  requireBrokerFloor,
  presenceBucket,
  mkSecretDir,
  writeSecretFile,
  type AuthPrepared,
  type SpaceAuth,
} from "@cotal-ai/core";
import { readFileSync, existsSync, lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { jetstreamManager, StorageType } from "@nats-io/jetstream";
import {
  CommandFailure,
  authDir,
  getSpaceAuth,
  hasUserAuthState,
  preloadSpaceAccounts,
  putSpaceAuth,
  connectionEvictorCredsKey,
  membershipConfigPath,
  membershipObserverCredsKey,
  membershipRwCredsKey,
  MEMBERSHIP_CONFIG_KIND,
  MEMBERSHIP_RW_CREDS_KIND,
  WEB_CREDS_KIND,
  webCredsKey,
  meshesForRoot,
  rotateSystemCreds,
  staleSystemCreds,
  SYSTEM_CREDS_FILES,
  userAuthStateDir,
  userAuthSpacesOnDisk,
  workspaceSecretStore,
  readBrokerPolicy,
  brokerAccountResolver,
  retainSystemSigningSeed,
  NATS_PIDFILE,
  terminalWidth,
} from "@cotal-ai/workspace";
import { resolveAuthProvider } from "../lib/auth-proc.js";
import { c, hang } from "../ui.js";
import { resolveNatsServer, unreadVersion, type NatsServer } from "../lib/nats-bin.js";
import { cotalPath, cotalRoot } from "../lib/paths.js";
import { shellWord } from "../lib/endpoint-errors.js";
import { namedOpenConfig } from "../lib/legacy-start.js";
import { unparsableDaemonCredsNotice } from "./stack-up.js";
import { configuredStoreDir } from "../lib/store-dir.js";
import { freePort } from "../lib/up-broker-address.js";
import { assertManagerPayload } from "./up-transport.js";

// SPEC §13.12: reads the connected broker's version, and refuses loud below the 2.12 floor
// before any provisioning touches it (the same gate `requireBrokerFloor` enforces on every other
// control-surface connection).
export type BrokerFacts = { version: string; presenceFileBacked: boolean };

/** The broker's version, and whether `space`'s presence stream exists file-backed. Cotal creates
 *  it in memory (#1356), so only a bucket an older cotal created is file-backed; an absent one
 *  will be created in memory by `setupSpaceStreams`. */
export async function brokerVersion(server: string, space: string, creds?: string): Promise<BrokerFacts> {
  const nc = await dialerFor(server)({ servers: server, ...standaloneConnectOpts({ creds, tls: false }) });
  try {
    requireBrokerFloor(nc);
    const version = nc.info?.version ?? "";
    let presenceFileBacked = false;
    try {
      const info = await (await jetstreamManager(nc)).streams.info(`KV_${presenceBucket(space)}`);
      presenceFileBacked = info.config.storage === StorageType.File;
    } catch (e) {
      const err = e as { message?: string; api_error?: { err_code?: number } };
      if (err.api_error?.err_code !== 10059 && !/stream not found/i.test(err.message ?? "")) throw e;
    }
    return { version, presenceFileBacked };
  } finally {
    await drainAndClose(nc);
  }
}

/**
 * Render and write the config for an OPEN (no-auth) broker, returning its path. It names `space`,
 * because an open root holds no account that would ({@link namedOpenConfig}).
 *
 * The `authSetup` sibling for the no-auth mode. Open mode previously launched nats-server from
 * bare CLI flags and so never passed through any renderer — meaning the REQUIRED transport union
 * on the config renderers covered the auth path only, and a `--tls-cert`/`--tls-key` pair given to
 * an open-mode `up` would have been accepted while the broker came up in cleartext. Routing open
 * mode through a renderer is what makes the union total: there is now no route to a listener that
 * does not state its transport.
 */
export function writeOpenBrokerConf(storeDir: string, space: string, opts: { brokerVersion: string; port: number; host: string; transport: BrokerTransport; maxFileStore?: number; maxPayload?: number; logFile?: string; logfileSizeLimit?: number; logfileMaxNum?: number }): string {
  const confPath = cotalPath("server-open.conf");
  writeBrokerConfig(
    confPath,
    namedOpenConfig(openServerConfig({ brokerVersion: opts.brokerVersion, port: opts.port, host: opts.host, storeDir: configuredStoreDir(cotalRoot(), storeDir), maxFileStore: opts.maxFileStore, maxPayload: opts.maxPayload, logFile: opts.logFile, logfileSizeLimit: opts.logfileSizeLimit, logfileMaxNum: opts.logfileMaxNum, transport: opts.transport }), space),
  );
  return confPath;
}

/** Write a broker configuration that `up` renders again on every start. Something other than this
 *  account's own regular file at its path, such as a symlink or a folder, is refused by name and
 *  left as it is. Moving it aside loses nothing, because the next `up` writes the file again.
 *  Other write failures name the path and errno, and remain known failures before a launch. */
function writeBrokerConfig(path: string, text: string): void {
  try { writeSecretFile(path, text); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A nonblocking write-only open can fail ENXIO for non-regular entries before the secure
    // writer can inspect its descriptor. An absent or regular entry still means a write failure.
    const entry = code === "EPERM" || code === "EISDIR" || code === "EACCES" || code === "ENXIO" ? lstatSync(path, { throwIfNoEntry: false }) : undefined;
    if (code !== "EPERM" && code !== "EISDIR" && code !== "EACCES" && (!entry || entry.isFile()))
      throw new CommandFailure("failed", "OPERATION_FAILED", `up could not write the broker configuration ${path}${code ? ` (${code})` : ""}; nothing was started`, {
        target: { path }, remedy: `correct the write failure at ${path}, then run \`cotal up\` again, which writes the configuration again`,
      });
    const what = entry?.isSymbolicLink() ? "is a symlink" : entry?.isDirectory() ? "is a folder" : code === "EACCES" ? "cannot be written by this account" : "is not a regular file this account owns";
    throw new CommandFailure("refused", "PERMISSION_DENIED", `the broker configuration ${path} ${what}, so up cannot write it; it was left as it is and nothing was started`, {
      target: { path }, remedy: `move it aside, as mv ${shellWord(path)} ${shellWord(`${path}.old`)} does, then run \`cotal up\` again, which writes it from the space's trust`,
    });
  }
}

/** The refusal for a trust record of the space that this account cannot read. It holds the space's
 *  keys, so the step makes it readable again and never removes it. Any other error as it is. */
function unreadableTrust(error: unknown): unknown {
  const { code, path } = error as NodeJS.ErrnoException;
  if (code !== "EACCES" && code !== "EPERM" || typeof path !== "string") return error;
  return new CommandFailure("refused", "PERMISSION_DENIED", `the space's trust record ${path} cannot be read by this account (${code}); nothing was started`, {
    target: { path }, remedy: `make it readable by you again, as chmod 600 ${shellWord(path)} does, then run \`cotal up\` again; it holds the space's keys, so keep it`,
  });
}

/** Ensure the space's trust material exists and render a server config. The caller can mint
 *  the setup credential after connector reconciliation. The account signing key
 *  in `.cotal/auth` is what `cotal mint` and the manager later use to issue per-agent creds.
 *
 *  USER MODE (`user` set): additionally run the registered auth provider's `prepareServer` over the
 *  SPACE-SCOPED state dir (`.cotal/auth/<space>/` — the multi-space-ready layout; nothing user-auth
 *  lives flat) and preload its extra account(s) into the broker config. The inverse is fail-closed:
 *  a space whose user-auth state exists MUST keep being started with --user-auth — regenerating the
 *  config without the callout account would silently break every sentinel connect.
 *
 *  `rotateSys` (`cotal up --rotate-sys`) is the class-3 renewal for an EXISTING space: rotate the
 *  system account, re-mint `membership-observer.creds` + `connection-evictor.creds` against the
 *  successor, and render the config from the ROTATED record so the broker this `up` starts is the one
 *  that trusts them. It belongs here because this is the single site that both owns the trust record
 *  and renders `server.conf`; anywhere else would publish creds the live broker cannot honor. */
export async function authSetup(
  storeDir: string,
  server: string,
  space: string,
  host: string = "127.0.0.1",
  user: { idpUrl?: string } | undefined,
  // NON-OPTIONAL, and it used to default to `{ kind: "plaintext" }`. That default was the hole: the
  // manifest path called this with five arguments and silently got a cleartext listener while the
  // operator's `--tls-cert` sat validated and unused. A default here cannot be right, because the
  // safe value and the common value are different values — every caller knows its transport, and
  // the one that does not is the one that must not compile.
  transport: BrokerTransport,
  rotateSys = false,
  maxFileStore?: number,
  quietBoot = false,
  // `--auth-timeout`, `--max-payload` and `--account-resolver`. Each absent value falls back to the one the root's broker
  // policy records, so a bare `up` renders what an earlier `up` set. They arrive as one object
  // rather than two trailing optional numbers: a transposed pair of those renders a wrong
  // configuration in silence.
  requested: { authTimeout?: number; maxPayload?: number; accountResolver?: "memory" | "full"; manager?: boolean; logFile?: string; logfileSizeLimit?: number; logfileMaxNum?: number; wsPort?: number } = {},
): Promise<{ brokerBinary: NatsServer; confPath: string; mintProvisioner: () => Promise<string>; wsPort: number; moveWebsocketPort: () => Promise<number>; prepared?: AuthPrepared; stateDir?: string; authTimeout?: number; maxPayload?: number; accountResolver: "memory" | "full" }> {
  const dir = authDir(cotalRoot()); // the broker config (server.conf) still lands under the FS auth dir
  const store = workspaceSecretStore(cotalRoot());
  const limits = loadAccountLimits(cotalRoot());
  let auth: SpaceAuth | undefined = await getSpaceAuth(store, space).catch((error: unknown) => { throw unreadableTrust(error); });
  if (!auth) {
    auth = await createSpaceAuth(space, limits);
    // The trust record is written last. Until it exists the next up treats the space as fresh and
    // mints all of this again, so an up stopped partway never leaves a space without its $SYS creds.
    await provisionMembershipCreds(auth, cotalRoot(), space); // the observer is minted while the $SYS seed is in memory (fresh-space only)
    // Smoke only: hold a new space with part of its material written, so a signal can land there.
    if (process.env.COTAL_SMOKE_HOLD_IN_SPACE_AUTH === "1") await new Promise((done) => setTimeout(done, 60_000));
    await retainSystemSigningSeed(store, auth); // the host keeps the seed itself, beside the record, for own-broker caller issuance
    await putSpaceAuth(store, auth); // strips the $SYS seed at rest
    // A fresh space's $SYS material was just minted from the seed this branch holds in memory, so
    // the ASK is already satisfied, so say so rather than rotating a one-second-old account, and never
    // report a rotation that did not happen.
    if (rotateSys) console.log(c.dim("• --rotate-sys: this space is new, so its $SYS creds were just minted - nothing to rotate"));
  } else if (rotateSys) {
    // Third and last of the stopped-broker checks, at the one point every rotation path converges on.
    // The other two live in `up`'s reachable-listener branch: this root's recorded mesh at the
    // requested address, and any UNIDENTIFIED listener there (which refuses rather than free-porting
    // around a broker that may be serving this root's own server.conf and store). This one reads the
    // root's ownership records for a broker at an address nobody probed. It reports what those
    // records say, not what the process table says (see its own comment for the residual), and fails
    // CLOSED, so an ambiguous record refuses exactly like a live one.
    await assertRootBrokerStopped(cotalRoot());
    // Fails loud: a caller that swallowed this would boot the broker on the RETIRED system account
    // while `doctor auth` reported the rotation as done.
    const rot = await rotateSystemCreds(cotalRoot(), space);
    auth = rot.auth; // the config below MUST be rendered from the successor, never the pre-rotation copy
    console.log(
      c.green(`✓ rotated the system account for "${space}"`) +
        c.dim(` (generation ${rot.gen}) - re-minted ${SYSTEM_CREDS_FILES.join(" + ")}${rot.expiresAt ? `, valid to ${new Date(rot.expiresAt * 1000).toISOString().slice(0, 10)}` : ""}`),
    );
    // Say exactly what is true. The retirement is CONFIG-LOAD-BOUND: an old cred dies against any
    // broker that loads the successor config, which is every broker started from this root from here
    // on, but a stale nats-server still holding the pre-rotation config in memory would keep
    // honoring it, so "now dead" without that qualifier oversells the guarantee.
    console.log(c.dim("  the data account, every agent cred and the JetStream store are untouched. The OLD $SYS creds are refused by any broker that loads this config; a stale broker still running the previous config would still honor them, so stop those first."));
    // A full backup binds to the trust chain it was taken against: `rootChainCommitment` hashes the
    // operator JWT and the system account, both of which just changed, so `cotal up --restore`
    // refuses every full artifact taken before this moment. That is correct (it is a different trust
    // root), but it is only obvious to someone who has read the fingerprint code, and rotation is
    // now a routine 30-day act rather than a once-per-space event. Say it at the moment it becomes
    // true, not in a doc the operator reads after the restore has already failed.
    console.log(c.dim("  NOTE: full backups taken before this rotation can no longer be restored (they are bound to the retired trust chain) - take a fresh `cotal backup` once the mesh is up."));
  }
  const limited = await applyAccountLimits(auth, limits);
  if (limited !== auth) {
    await assertRootBrokerStopped(cotalRoot(), "accountLimits");
    const before = decodeNatsJwt<{ nats: { limits?: AccountLimits } }>(auth.account.jwt).nats.limits ?? {};
    const changed = Object.entries(limits ?? {}).filter(([key, value]) => before[key as keyof typeof before] !== value);
    auth = limited;
    await putSpaceAuth(store, auth);
    console.error(c.green(`✓ applied accountLimits for "${space}": ${changed.map(([key, value]) => `${key}=${value}`).join(", ")}`));
  }
  // The DATA half of the membership bundle, on EVERY path — see healMembershipDataCreds.
  await healMembershipDataCreds(auth, cotalRoot(), space, quietBoot);
  await provisionWebCreds(auth, cotalRoot(), space, quietBoot);
  // The $SYS creds must be signed by the system account THIS boot is about to put in `server.conf`.
  // A rotation that committed the trust record and then died leaves them stale, unexpired, and
  // broker-dead and, crash-before-either-write, stale in a way that no comparison between the two
  // FILES can see (they agree with each other; they just disagree with the record). This is the one
  // place holding both, on the one path that renders the config, so it is where the split is caught.
  //
  // REFUSE, do not warn. A warning is what the `--detach` path turns into an unread log line under a
  // green "✓ running in the background", which is the false success this whole change exists to
  // remove. And what stays broken is not only the display feed: live connection EVICTION rides the
  // same pair, so booting here would silently downgrade revocation to deny-new for the life of the
  // mesh. The repo's posture is to throw rather than degrade, and the recovery is one command that
  // this message names.
  const stale = staleSystemCreds(cotalRoot(), auth.sys.pub, space);
  if (stale.length)
    throw new Error(
      `${stale.map((x) => `${x.file} (signed by ${x.iss ? `${x.iss.slice(0, 12)}…` : "an unreadable issuer"})`).join(", ")} ` +
        `${stale.length === 1 ? "is" : "are"} not signed by this space's system account (${auth.sys.pub.slice(0, 12)}…) - ` +
        "an interrupted rotation left the $SYS creds behind the trust record, so the broker would deny them and live eviction + the membership feed would stay down. " +
        "Re-run the rotation to land a complete generation: `cotal up --rotate-sys`",
    );
  const stateDir = userAuthStateDir(cotalRoot(), space); // the provider's space-scoped state dir
  if (!user && hasUserAuthState(cotalRoot(), space)) {
    throw new Error(`space "${space}" has user auth enabled (state under ${stateDir}) - start it with \`cotal up --user-auth\`, or remove that directory deliberately to disable user auth (existing logins/grants die with it)`);
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
        store: workspaceSecretStore(cotalRoot()),
        dir: stateDir,
        idpUrl: user.idpUrl,
      });
    } catch (e) {
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  const port = Number(new URL(server).port) || 4222;
  // A reused controller manager advertises its launch-time WebSocket port.
  const wsPort = requested.wsPort ?? await freePort(host);
  const confPath = resolve(dir, "server.conf");
  // EVERY tenant of this root, not just the one being booted: `resolver_preload` is a whole-broker
  // map, so a config rendered from one space evicts the rest silently. `auth` leads the list because
  // this function's copy can be fresher than the disk (a space created above, or one whose trust
  // record `--rotate-sys` just replaced). Refuses on an unreadable record rather than dropping it.
  const spaces = preloadSpaceAccounts(dir, auth);
  const enabled = userAuthSpacesOnDisk(dir);
  for (const enabledSpace of enabled) {
    if (!spaces.some((s) => s.space === enabledSpace))
      throw new Error(`space "${enabledSpace}" has user auth enabled but no data account record - refusing to render an incomplete broker resolver`);
  }
  const extraAccounts: Array<{ pub: string; jwt: string }> = [];
  for (const enabledSpace of enabled) {
    const accounts = enabledSpace === space && prepared
      ? prepared.extraAccounts
      : await resolveAuthProvider().preloadAccounts({ store, space: enabledSpace });
    extraAccounts.push(...accounts);
  }
  // Owner-private regardless of umask, as `writeOpenBrokerConf` writes the open configuration: the
  // broker preset refuses a configuration that other local users can write.
  const recorded = readBrokerPolicy(cotalRoot());
  const authTimeout = requested.authTimeout ?? recorded?.authTimeout;
  const maxPayload = requested.maxPayload ?? recorded?.maxPayload;
  if (requested.manager === true) assertManagerPayload(maxPayload);
  const resolverChoice = requested.accountResolver ?? recorded?.accountResolver ?? "memory";
  const accountResolver = brokerAccountResolver(cotalRoot(), resolverChoice === "full" ? "full" : undefined);
  // Owner-private like the auth dir: nats-server writes each pushed claim here.
  if (accountResolver.kind === "full") mkSecretDir(accountResolver.directory);
  const brokerBinary = await resolveNatsServer();
  if (!brokerBinary.version) throw unreadVersion(brokerBinary);
  const render = (ws: number) => writeBrokerConfig(confPath, serverConfig(auth, spaces, { brokerVersion: brokerBinary.version!, transport, port, storeDir: configuredStoreDir(cotalRoot(), storeDir), maxFileStore, authTimeout, maxPayload, accountResolver, logFile: requested.logFile, logfileSizeLimit: requested.logfileSizeLimit, logfileMaxNum: requested.logfileMaxNum, host, wsPort: ws, wsHost: host, extraAccounts }));
  render(wsPort);
  // The chosen port is free now, but nothing holds it until the broker binds it. When another process
  // takes it first, the broker exits before readiness, and a controller stack start renders this
  // configuration again on a newly chosen port.
  const moveWebsocketPort = async () => { const moved = await freePort(host); render(moved); return moved; };
  // Connector reconciliation can outlast the provisioner's lifetime. Mint only when boot needs it
  // to probe the listener, create streams and buckets, or seed the channel registry.
  const mintProvisioner = () => mintCreds(auth, newIdentity(), "provisioner");
  return { brokerBinary, confPath, mintProvisioner, wsPort, moveWebsocketPort, ...(prepared ? { prepared, stateDir } : {}), ...(authTimeout !== undefined ? { authTimeout } : {}), ...(maxPayload !== undefined ? { maxPayload } : {}), accountResolver: resolverChoice };
}

/**
 * Refuse the rotation if this root's own bookkeeping still shows a broker running. This is a
 * BEST-EFFORT check over Cotal-managed ownership records, NOT a proof that no process is serving this
 * root, and the difference matters: a survivor keeps honoring the retired account from memory, and a
 * second broker on the successor opens that survivor's JetStream store underneath it.
 *
 * Two records, because either alone has a blind spot. The PID FILE catches a broker this root started
 * whose registry row was lost. The REGISTRY sweep catches one recorded for this root at some OTHER
 * address, which no probe of the requested URL would reach. Both fail CLOSED: an unreadable or
 * malformed pid file refuses exactly like a live one, since "cannot tell" and "still running" have
 * the same consequence.
 *
 * WHAT IT CANNOT SEE: both records are mutable, and neither is written by a broker started outside
 * `cotal up`. Delete both while the process lives, or run
 * `nats-server -c <root>/.cotal/auth/server.conf` by hand, and this returns success having probed
 * nothing. The requested address is covered separately (an unidentified listener there refuses the
 * rotation rather than moving to a free port), which leaves a hand-started broker on a DIFFERENT port
 * as the honest residual. Closing that needs something a survivor holds and cannot delete, an
 * exclusive store lock, which does not exist today; until it does, do not run `nats-server` against
 * this root's config outside `cotal up`.
 *
 * Not a general `up` guard: an ordinary boot adopting or replacing a listener is a supported flow with
 * its own claim machinery. This is specifically the precondition for retiring an authority.
 */
export async function assertRootBrokerStopped(root: string, operation = "--rotate-sys"): Promise<void> {
  const pidPath = join(root, ".cotal", NATS_PIDFILE);
  if (existsSync(pidPath)) {
    let raw: string;
    try {
      raw = readFileSync(pidPath, "utf8").trim();
    } catch (e) {
      throw new Error(`${operation}: ${pidPath} exists but cannot be read (${(e as Error).message}) - refusing to change ${operation === "--rotate-sys" ? "trust" : "account limits"} while a broker for this root may still be running; \`cotal down\` first`);
    }
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0)
      throw new Error(`${operation}: ${pidPath} does not hold a pid (${JSON.stringify(raw)}) - refusing to change ${operation === "--rotate-sys" ? "trust" : "account limits"} while a broker for this root may still be running; \`cotal down\` first`);
    let live: boolean;
    try {
      process.kill(pid, 0); // signal 0 is a liveness probe, it signals nothing
      live = true;
    } catch (e) {
      // EPERM means the process EXISTS and is not ours to signal, i.e. alive for this purpose.
      live = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    if (live)
      throw new Error(`${operation}: this root's broker is still running (pid ${pid}) - stop it before changing broker trust or account limits: \`cotal down\``);
  }
  // A broker recorded for this root at ANY address, still answering. The rotate refusal earlier in
  // `up` only sees the URL this invocation asked for; this sees the ones it did not.
  for (const m of meshesForRoot(root)) {
    if (await isReachable(m.server))
      throw new Error(`${operation}: mesh "${m.space}" for this root is still reachable at ${m.server} - stop it first (\`cotal down\`), then change broker trust or account limits`);
  }
}

/** Provision the DATA-account half of the membership bundle, on EVERY `up` rather than only a fresh
 *  space. Idempotent: it writes only what is absent and is silent when both are present.
 *
 *  WHY THIS IS SEPARATE FROM {@link provisionMembershipCreds}. That function mints the whole bundle
 *  in the fresh-space branch because the `$SYS` signing seed exists only there and is never
 *  persisted — true of `membership-observer.creds` and `connection-evictor.creds`. The delivery daemon
 *  mints a missing evictor itself on a single-space root that retained its system-account signing
 *  seed, so that one no longer needs a rotation; a root without the seed still needs one. It is NOT
 *  true of the other two.
 *  `membership-rw.creds` is signed by the DATA account, whose signing seed IS persisted, and
 *  `membership.json` is just that account's public id. Neither needs the `$SYS` window, so binding
 *  them to it left every space provisioned before the feature permanently without the feed.
 *
 *  That gap was not theoretical. A space with a complete `$SYS` pair, missing only the rw cred,
 *  reported `the membership bundle is incomplete here (missing membership-rw.creds)` on every
 *  delivery-daemon start and served a traffic-only graph, and the documented remedy did not work:
 *  `--rotate-sys` re-mints the `$SYS` pair and never calls the provisioner, so it wrote neither the
 *  rw cred nor the account id. `mintMembershipObserverCreds` even names that rotation as the fix in
 *  its own error text — advice that could not succeed. Healing here fixes both spellings at once:
 *  the ordinary `up` repairs the data half with no rotation at all, and a rotation now repairs it
 *  too, because this runs after both branches converge. */
async function healMembershipDataCreds(auth: SpaceAuth, root: string, space: string, quietBoot = false): Promise<void> {
  try {
    const store = workspaceSecretStore(root);
    // THE RESOLVERS, not the bare kinds (P7 §2 rule 1). Both reads below are absent-means-MINT, which
    // is precisely why the location must be resolved through the choke point: a canonical read on a
    // root whose material is still flat answers "absent" and mints a SECOND live cred beside the one
    // the running daemons hold. `up` is a workstation composition by construction, so the resolver
    // gets the FS arm and moves the material on this first touch.
    const composition = { injected: false as const, root };
    const rwKey = membershipRwCredsKey(space, composition);
    const wrote: string[] = [];
    const rw = await store.get(rwKey);
    if (rw === undefined) {
      await store.put(rwKey, await mintCreds(auth, newIdentity(), "membership-rw"));
      wrote.push(MEMBERSHIP_RW_CREDS_KIND); // the KIND is what an operator reads, never the segmented key
    } else if (credsProblem(rw) !== undefined && !quietBoot) console.error(c.yellow(`! ${unparsableDaemonCredsNotice([MEMBERSHIP_RW_CREDS_KIND])}`));
    const configPath = membershipConfigPath(root, space);
    if (!existsSync(configPath)) {
      mkSecretDir(dirname(configPath)); // harden the per-space dir before the file lands, as the fresh path does
      writeSecretFile(configPath, JSON.stringify({ accountId: auth.account.pub }));
      wrote.push(MEMBERSHIP_CONFIG_KIND);
    }
    if (wrote.length && !quietBoot)
      console.log(c.dim(`• membership: provisioned ${wrote.join(" + ")} - the data-account half needs no system-account rotation`));
  } catch (e) {
    // Best-effort, exactly like the fresh-space provisioner: a failure here leaves the graph on
    // traffic-only and leaves delivery untouched. It must never keep the mesh from starting.
    console.error(c.dim(`• broker-sourced membership not repaired: ${(e as Error).message}`));
  }
}

/** The web dashboard's read-only cred, on EVERY `up` of a static space: `cotal service start web`
 *  defaults its `--creds` to this file. Idempotent and absent-means-mint, through the resolver as
 *  {@link healMembershipDataCreds} is. It is the `observer` profile, minted without an expiry, as the
 *  `cotal auth mint --profile observer` recipe this replaces was: the dashboard reads the file once at
 *  start and holds its connection, and no renewal owner reloads it. Best-effort for the same reason as
 *  the membership heal: a failure here must never keep the mesh from starting. */
export async function provisionWebCreds(auth: SpaceAuth, root: string, space: string, quietBoot = false): Promise<void> {
  try {
    const store = workspaceSecretStore(root);
    const key = webCredsKey(space, { injected: false, root });
    if ((await store.get(key)) !== undefined) return;
    await store.put(key, await mintCreds(auth, newIdentity(), "observer"));
    if (!quietBoot) for (const line of hang("• ", `web: provisioned ${WEB_CREDS_KIND} - the dashboard's read-only credential, the \`service start web\` default`, terminalWidth(process.stdout))) console.log(c.dim(line));
  } catch (e) {
    console.error(c.dim(`• web dashboard credential not provisioned: ${(e as Error).message}`));
  }
}

/** Mint the two scoped creds the delivery daemon's membership feed loads (broker-sourced graph
 *  membership), at the FRESH `cotal up` while the in-memory `$SYS` signing seed still exists:
 *   - `membership-observer.creds` — SYSTEM-account CONNZ reader (the only window it is minted here:
 *     the trust record carries no `$SYS` seed, and the retained custody record serves caller issuance only).
 *   - `membership-rw.creds` — DATA-account members-read + feed-write.
 *   - `membership.json` — the DATA account id (the CONNZ/event subjects pin it; non-secret, but kept
 *     0600 alongside the creds).
 *  All 0600. Best-effort: a failure logs and leaves the feed disabled (the graph degrades to traffic-
 *  only, delivery is untouched). Runs only on a FRESH space (the `if (!auth)` branch); a normal down/up
 *  keeps `.cotal/auth` + these creds and reuses them. A space provisioned before this feature has no
 *  in-memory `$SYS` seed, so it gains membership only when its auth is regenerated (a fresh `.cotal/auth`)
 *  — a documented migration property, not a silent no-op.
 *  Coupling: `cotal clean all` deletes this identity-derived set (removeLocalState in clean.ts) —
 *  a cred added here must be added to that removal list too. `membership-rw.creds` is a MIGRATED kind:
 *  its write/read/delete all go through the {@link SecretStore} seam (here, the feed reader, and clean),
 *  so the renewal owner can re-sign it into a hosted store. The observer / evictor / config stay on the
 *  raw FS (static $SYS creds + non-secret config, not renewable kinds). */
async function provisionMembershipCreds(auth: SpaceAuth, root: string, space: string): Promise<void> {
  try {
    const observer = await mintMembershipObserverCreds(auth, newIdentity());
    const rw = await mintCreds(auth, newIdentity(), "membership-rw");
    // D5 slice 4: the KICK-only connection-evictor cred — same mint-only-at-fresh-`up` window as
    // the observer ($SYS seed in memory here). The delivery daemon pairs it with the observer to
    // close a revoked/removed principal's live connections. A space without it degrades to
    // deny-new-only (durable reauth) — surfaced loudly by the removal path, never silent.
    const evictor = await mintConnectionEvictorCreds(auth, newIdentity());
    // All four land through the per-kind resolvers (P7 §2 rule 1), and all four through the store's
    // `put`, which is the same `mkSecretDir` + atomic write the raw `writeSecretFile` did — the
    // difference being that it hardens the PER-SPACE dir the material now lives in rather than
    // `.cotal/` itself. This is the fresh-space branch, so nothing is there to migrate; it calls the
    // resolvers anyway because a kind with two write paths is a kind that grows two layouts.
    const composition = { injected: false as const, root };
    const store = workspaceSecretStore(root);
    await store.put(membershipObserverCredsKey(space, composition), observer);
    await store.put(membershipRwCredsKey(space, composition), rw);
    await store.put(connectionEvictorCredsKey(space, composition), evictor);
    const configPath = membershipConfigPath(root, space);
    mkSecretDir(dirname(configPath));
    writeSecretFile(configPath, JSON.stringify({ accountId: auth.account.pub }));
  } catch (e) {
    console.error(c.dim(`• broker-sourced membership not provisioned: ${(e as Error).message}`));
  }
}
