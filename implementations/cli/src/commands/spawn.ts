import { spawn as spawnProcess, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { resolve as resolvePath } from "node:path";
import {
  agentFilePath,
  connectorServers,
  spawnEnvAllow,
  deprovisionAgent,
  discardLaunchArtifacts,
  firstFreeName,
  isReachable,
  loadAgentFile,
  reclaimWithChild,
  loadCotalConfig,
  modelPolicyRefusal,
  mintCreds,
  newIdentity,
  DEV_OWNER,
  parseShareSelection,
  principalKey,
  mintLifecycleUid,
  MANAGED_HANDOFF_FILE_ENV,
  parseManagedLifecycleHandoff,
  spawnNameError,
  provisionAgent,
  provisionAgentDurables,
  registry,
  resolveAuthProvider,
  resolveReadAcl,
  bearerCommandFailure,
  CotalEndpoint,
  transferBucket,
  writeTransfer,
  type AgentDef,
  type CompletionResult,
  type Connector,
  type ExtensionRef,
  type FlagSpec,
  type FlagValues,
  type LaunchOpts,
  type LaunchSpec,
  type ManagedLifecycleHandoff,
  type ParsedArgs,
  type SpaceAuth,
} from "@cotal-ai/core";
import {
  agentActorTokenKey,
  agentCredsKey,
  agentSecretFilePaths,
  agentSentinelCredsKey,
  authDir,
  credsFlag,
  defaultAgentOverride,
  defaultPersonaOverride,
  defaultPersonaRef,
  launchFlags,
  loadMeshes,
  findMesh,
  getSpaceAuth,
  materializeSecretToFile,
  mergeLaunchOptions,
  parseLaunchOptions,
  preflightOrThrow,
  provenance,
  resolveAgentType,
  resolveMeshTarget,
  resolveTargetOrThrow,
  serverFlag,
  spaceAccountPath,
  spaceFlag,
  spaceKey,
  userAuthStateDir,
  workspaceSecretStore,
  refreshRegistrationPolicy,
  resolveSeatControlTarget,
  connectUserControlOrExit,
  userViewAuth,
  type Check,
  type ConnectFlags,
  type ControlAuth,
  type ControlTarget,
  type MeshTarget,
} from "@cotal-ai/workspace";
import { c } from "../ui.js";
import { completedFlagValue, completingFlagValue, hasCompletedFlagValue, positionalsForCompletion } from "../lib/completion.js";
import { preflightOrExit, resolveTargetOrExit } from "../lib/connect.js";
import { askManager, failIfNotOk, onInstanceOrExit, resolveControlTarget, START_TIMEOUT_MS, withControlConnection } from "../lib/control.js";
import { listDeclaredChannels, listDeclaredRoles, listPersonas } from "../lib/personas.js";
import { spawnManifest } from "./spawn-manifest.js";
import { extensionNames, materializeExtension } from "../ext-loader.js";
import { claimManagedHandoff } from "../managed-handoff.js";
import {
  checkDialPolicy,
  checkEnforcement,
  checkServer,
  checkUserBundle,
  persistRemoteUserEntry,
  probeEnforcement,
  tlsIntent,
  userExchangeIssuer,
  verifyUserExchange,
  type UserBundle,
} from "./meshes-add.js";

const ENROLLMENT_URL_ENV = "COTAL_ENROLLMENT_URL";
const ENROLLMENT_FILE_ENV = "COTAL_ENROLLMENT_FILE";

/** Remove the one line terminator a text file ends with, and nothing else: the file holds the URL
 *  and at most that terminator. Any other whitespace belongs to the credential the owner minted and
 *  must reach the URL grammar, which refuses it rather than silently redeeming a repaired URL. The
 *  environment value is taken byte for byte; nothing is stripped from it. */
function stripTrailingNewline(value: string): string {
  return value.replace(/\r?\n$/, "");
}

export function enrollmentInput(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const rawUrl = env[ENROLLMENT_URL_ENV];
  const file = env[ENROLLMENT_FILE_ENV]?.trim();
  if (rawUrl && file)
    throw new Error(`both ${ENROLLMENT_URL_ENV} and ${ENROLLMENT_FILE_ENV} are set - pass one enrollment source, not both`);
  if (rawUrl) return rawUrl;
  if (!file) return undefined;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch (e) {
    throw new Error(`cannot read the enrollment file (${e instanceof Error ? e.message : String(e)})`);
  }
  if (!st.isFile()) throw new Error("the enrollment file path is not a regular file");
  if (process.platform !== "win32" && (st.mode & 0o777) !== 0o600)
    throw new Error("the enrollment file must have mode 0600");
  const value = stripTrailingNewline(readFileSync(file, "utf8"));
  if (!value) throw new Error("the enrollment file is empty");
  return value;
}

export function scrubEnrollmentEnv(env: Record<string, string | undefined> | undefined): void {
  if (!env) return;
  for (const key of Object.keys(env)) {
    const normalized = key.toUpperCase();
    if (normalized === ENROLLMENT_URL_ENV || normalized === ENROLLMENT_FILE_ENV) delete env[key];
  }
}

export interface EnrollmentBundle extends RemoteAgentMaterial {
  space: string;
  brokerAccess: { kind: string; [key: string]: unknown };
  authServiceUrl: string;
  idp: { url: string; issuer: string; audience: string };
  server?: string;
  tlsRequired?: boolean;
  userAuth?: unknown;
  policy?: unknown;
}

export function checkEnrollmentBundle(raw: unknown, actor: string): { bundle: EnrollmentBundle; stock?: UserBundle } {
  const material = checkRemoteAgentMaterial(raw, actor);
  if (!material.ok) throw new Error(material.message.replaceAll("agent-provisioning endpoint", "enrollment endpoint"));
  const o = raw as Partial<EnrollmentBundle>;
  if (typeof o.space !== "string" || !o.space) throw new Error("the enrollment bundle names no space");
  if (o.brokerAccess === null || typeof o.brokerAccess !== "object" || typeof o.brokerAccess.kind !== "string" || !o.brokerAccess.kind)
    throw new Error("the enrollment bundle carries no brokerAccess kind");
  if (typeof o.authServiceUrl !== "string" || !o.authServiceUrl)
    throw new Error("the enrollment bundle carries no authServiceUrl");
  const idp = o.idp;
  if (idp === null || typeof idp !== "object" || typeof idp.url !== "string" || !idp.url ||
      typeof idp.issuer !== "string" || !idp.issuer || typeof idp.audience !== "string" || !idp.audience)
    throw new Error("the enrollment bundle carries no complete idp { url, issuer, audience }");
  let stock: UserBundle | undefined;
  const hasStock = [o.server, o.tlsRequired, o.userAuth].some((v) => v !== undefined);
  const rawPolicy = (o as { policy?: unknown }).policy;
  if (rawPolicy !== undefined && !hasStock)
    throw new Error("the enrollment bundle's policy requires its stock server, tlsRequired, and userAuth fields");
  if (hasStock) {
    if ([o.server, o.tlsRequired, o.userAuth].some((v) => v === undefined))
      throw new Error("the enrollment bundle's stock mesh fields must include server, tlsRequired, and userAuth together");
    const checked = checkUserBundle(JSON.stringify({
      space: o.space,
      server: o.server,
      tlsRequired: o.tlsRequired,
      userAuth: o.userAuth,
      policy: (o as { policy?: unknown }).policy,
      sentinelCreds: material.material.sentinelCreds,
    }));
    if (!checked.ok) throw new Error(checked.message.replace(/^✗\s*/, ""));
    stock = checked.value;
    if (stock.userAuth.idp.url !== idp.url || stock.userAuth.idp.issuer !== idp.issuer || stock.userAuth.idp.audience !== idp.audience)
      throw new Error("the enrollment bundle's stock userAuth IdP pins do not match its top-level idp pins");
    if (stock.userAuth.endpoints?.url !== o.authServiceUrl)
      throw new Error("the enrollment bundle's stock userAuth exchange URL does not match authServiceUrl");
    const access = o.brokerAccess as Record<string, unknown>;
    if (access.kind === "direct" && (typeof access.url !== "string" || !access.url))
      throw new Error("the enrollment bundle's direct brokerAccess carries no url");
    if (access.kind === "direct" && access.url !== stock.server)
      throw new Error("the enrollment bundle's direct brokerAccess url does not match its stock server");
  }
  return { bundle: { ...o, ...material.material, idp } as EnrollmentBundle, ...(stock ? { stock } : {}) };
}

/** What a managed handoff's bootstrap refuses with at each phase that runs a check shared with the
 *  enrollment path. Those checks' diagnostics, and the filesystem errors under them, quote the
 *  space, the server, the exchange URL, the actor or a path named for one of them, and a handoff
 *  refusal never echoes the document, so each sentence names only the field and the phase. */
const HANDOFF_REFUSALS = {
  space: "the managed handoff's space is malformed",
  bundle: "the managed handoff's mesh fields failed the user-auth bundle check",
  registration: "the managed handoff's space failed the local registration",
  target: "the managed handoff's space failed target resolution",
  server: "the managed handoff's server is not a broker URL this machine may dial",
  exchange: "the managed handoff's exchangeUrl failed the exchange check",
  enforcement: "the managed handoff's server failed the enforcement check",
  policy: "the managed handoff's exchangeUrl failed the policy refresh",
  preflight: "the managed handoff's server failed the broker preflight",
  bearer: "the managed handoff's actorToken failed the agent auth preflight",
} as const;

/** Map a parsed handoff onto the redeem consumer's shapes. Pure. */
export function handoffEnrollmentBundle(h: ManagedLifecycleHandoff): { bundle: EnrollmentBundle; stock: UserBundle } {
  const userAuth = { provider: h.authProvider, idp: h.idp, endpoints: { url: h.exchangeUrl }, remote: true };
  try {
    const { bundle, stock } = checkEnrollmentBundle({
      space: h.space, actor: h.actor, owner: h.owner, lifecycleUid: h.lifecycleUid, actorToken: h.actorToken, sentinelCreds: h.sentinelCreds,
      subscribe: h.subscribe, allowSubscribe: h.allowSubscribe, allowPublish: h.allowPublish,
      brokerAccess: { kind: "direct", url: h.server }, authServiceUrl: h.exchangeUrl, idp: h.idp,
      server: h.server, tlsRequired: h.tlsRequired, userAuth, ...(h.policy ? { policy: h.policy } : {}),
    }, h.actor);
    return { bundle, stock: stock! };
  } catch {
    throw new Error(HANDOFF_REFUSALS.bundle);
  }
}

/** With `refusals`, a step that fails its check or throws refuses with its phase's sentence instead
 *  of its diagnostic. */
async function registerEnrollmentMesh(stock: UserBundle, root: string, refusals?: typeof HANDOFF_REFUSALS): Promise<void> {
  const step = async <T>(phase: "server" | "exchange" | "enforcement" | "registration", run: () => Check<T> | Promise<Check<T>>): Promise<T> => {
    let check: Check<T>;
    try {
      check = await run();
    } catch (e) {
      throw refusals ? new Error(refusals[phase]) : e;
    }
    if (!check.ok) throw new Error(refusals?.[phase] ?? check.message.replace(/^✗\s*/, ""));
    return check.value;
  };
  await step("server", () => checkServer(stock.server, "the enrollment bundle's server"));
  const tlsRequired = stock.tlsRequired || tlsIntent(stock.server, false);
  const dial = await step("server", () => checkDialPolicy(stock.server, { tlsRequired, allowUnencryptedOverlay: false }));
  await step("exchange", () => verifyUserExchange(stock.userAuth.endpoints!.url!, userExchangeIssuer(stock.space)));
  await step("enforcement", async () => checkEnforcement("user", await probeEnforcement(stock.server), stock.server, stock.space, root));
  await step("registration", () => ({ ok: true, value: persistRemoteUserEntry(stock.space, stock.server, root, stock, tlsRequired, Boolean(dial.residual)) }));
}

/** Completion for `cotal spawn` — `--space <TAB>` lists the running meshes, and the first positional
 *  is a persona from the mesh this spawn would target. Resolved OFFLINE (registry + `current`, no
 *  probe — a <TAB> must stay cheap and never open the network), so it lists the *target* mesh's
 *  personas, not the cwd's. */
export function spawnComplete(argv: string[]): CompletionResult {
  const flag = completingFlagValue(argv, spawnFlags);
  if (flag?.name === "space")
    return { items: loadMeshes().map((m) => ({ value: m.space })), directive: "nofiles" };
  if (flag?.name === "agent")
    return { items: registry.all<Connector>("connector").map((c) => ({ value: c.name })), directive: "nofiles" };
  if (flag?.name === "role")
    return { items: declaredFrom(argv, listDeclaredRoles).map((value) => ({ value, description: "declared role" })), directive: "nofiles" };
  if (flag?.name === "config") {
    const current = argv[argv.length - 1] ?? "";
    if (current.includes("/") || current.includes("\\") || current.endsWith(".md")) return { items: [], directive: "default" };
    try {
      return { items: personaItems(argv), directive: "nofiles" };
    } catch {
      return { items: [], directive: "nofiles" };
    }
  }
  if (flag && ["subscribe", "allow-subscribe", "allow-publish"].includes(flag.name))
    return { items: declaredFrom(argv, listDeclaredChannels).map((value) => ({ value, description: "declared channel" })), directive: "nofiles" };
  if (flag && ["cwd", "file", "creds"].includes(flag.name)) return { items: [], directive: "default" };
  if (flag?.name === "runtime")
    return { items: ["pty", ...extensionNames("runtime")].filter((value, i, all) => all.indexOf(value) === i).map((value) => ({ value })), directive: "nofiles" };

  const positionals = positionalsForCompletion(argv, spawnFlags);
  // Only the first word after `spawn` is the persona positional; once it's typed, defer to the shell.
  if (positionals.length <= 1 && !hasCompletedFlagValue(argv, spawnFlags, "config")) {
    try {
      return { items: personaItems(argv), directive: "nofiles" };
    } catch {
      // No single target (no mesh, or several with no `current`) — fail CLOSED: offer no personas
      // rather than throw. `cotal spawn --space <TAB>` still lists the running meshes.
      return { items: [], directive: "nofiles" };
    }
  }
  return { items: [], directive: "nofiles" };
}

function personaItems(argv: string[]) {
  const target = resolveMeshTarget(process.cwd(), {
    space: completedFlagValue(argv, spawnFlags, "space"),
    server: completedFlagValue(argv, spawnFlags, "server"),
  });
  return listPersonas(target.root).map((p) => ({ value: p.name }));
}

/** Channels/roles declared by the TARGET mesh's personas — the same root {@link personaItems}
 *  uses, so `--role`/`--subscribe` complete from the personas this spawn would actually launch
 *  rather than from whatever project the operator is standing in. Offline (no probe) and FAIL
 *  CLOSED: with no single resolvable target, or a malformed persona file (see `declaredValues`),
 *  offer nothing rather than throw into the operator's shell. */
function declaredFrom(argv: string[], list: (root: string) => string[]): string[] {
  try {
    return list(
      resolveMeshTarget(process.cwd(), {
        space: completedFlagValue(argv, spawnFlags, "space"),
        server: completedFlagValue(argv, spawnFlags, "server"),
      }).root,
    );
  } catch {
    return [];
  }
}

/** Persona selection precedence shared by foreground and detached spawn. */
export function spawnPersonaRef(configFlag: string | undefined, positionals: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  return configFlag ?? positionals[0] ?? defaultPersonaRef("default", env);
}

/**
 * Auto-number `requested` past any peer already present on the mesh (foo → foo_2 → foo_3) — the same
 * series the manager's spawn funnel uses (firstFreeName). Foreground `cotal spawn` doesn't go through
 * the manager, so it has no name reservation: this is a best-effort, advisory check. It connects a
 * transient presence-watching endpoint, lets the roster settle, and snapshots the live names; two
 * simultaneous `cotal spawn`s can still race onto the same number. If the mesh is unreachable the
 * agent couldn't join it anyway, so dedup is skipped and the requested name stands.
 */
async function uniqueMeshName(
  requested: string,
  { space, server, auth }: { space: string; server: string; auth?: SpaceAuth },
): Promise<string> {
  // Reading presence in auth mode needs a credential (the bucket is OPEN-only for agents): a
  // short-lived least-privilege OPERATOR cred (presence/channel read + self-publish), the same throwaway
  // `cotal dm`/`send` mints to resolve a name → id.
  const creds = auth ? await mintCreds(auth, newIdentity(), "operator") : undefined;
  if (!(await isReachable(server, { creds }))) return requested;
  const ep = new CotalEndpoint({
    space,
    servers: server,
    creds,
    channels: [],
    consume: false,
    registerPresence: false, // an invisible probe — don't add ourselves to the roster we're reading
    watchPresence: true,
    card: { name: "spawn-probe", kind: "endpoint" },
  });
  ep.on("error", () => {}); // advisory: a presence-read hiccup must never block the spawn
  const ignoreNameProbeWarning = () => {};
  ep.on("warning", ignoreNameProbeWarning); // deliberate: this best-effort naming probe never owns spawn success
  await ep.start();
  try {
    // Presence replays from the KV bucket right after connect; settle until the roster count holds
    // steady across two polls (≤1s), then snapshot the names of the peers that are actually live.
    let prev = -1;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const n = ep.getRoster().length;
      if (n === prev) break;
      prev = n;
    }
    const taken = new Set(
      ep.getRoster().filter((p) => p.status !== "offline").map((p) => p.card.name),
    );
    return firstFreeName(requested, (n) => taken.has(n));
  } finally {
    await ep.stop();
  }
}


/** `cotal spawn`'s full grammar: target + the shared launch bundle + the two spawn-only modes
 *  (`--detach` = manager-run; `-f` = manifest deploy). Declared `as const` so the values cast
 *  below is compile-checked against exactly these specs. Foreground and detached parse the SAME
 *  flags — the old `spawn` vs `start` ability drift is structurally gone. */
export const spawnFlags = [
  spaceFlag,
  serverFlag,
  { ...credsFlag, description: "control-caller creds for an off-registry manager (--detach only)" },
  ...launchFlags,
  { name: "detach", type: "boolean", short: "d", description: "launch via the manager into a detached PTY (reattach with `cotal attach`)" },
  { name: "live-only", type: "boolean", description: "foreground only: skip the durable backstop (no read-ACL row; messages missed while disconnected are not replayed)" },
  { name: "file", type: "string", short: "f", value: "<cotal.yaml>", description: "deploy a manifest onto the running mesh" },
  { name: "dry-run", type: "boolean", description: "with -f: print the plan, mutate nothing" },
  { name: "allow-stale", type: "string", value: "<a,b>", description: "with -f: waive named stale agents (apply-only)" },
  { name: "runtime", type: "string", value: "<name>", description: "with -f: override the manifest's runtime" },
  { name: "on", type: "string", value: "<instance>", description: "with --detach: target a specific manager instance id (multi-manager space); default = class anycast; `ps`'s instance id, not roster's `local.…` principal id" },
  { name: "expect-owner", type: "string", value: "<u_…>", description: `with ${MANAGED_HANDOFF_FILE_ENV}: the owner the managed handoff must carry` },
  { name: "expect-lifecycle-uid", type: "string", value: "<uid>", description: `with ${MANAGED_HANDOFF_FILE_ENV}: the lifecycle UID the managed handoff must carry` },
] as const satisfies readonly FlagSpec[];

/** Foreground `cotal spawn` resolves its `--agent` connector from the registry (spawn.ts below); on
 *  the published binary nothing static-imports connectors, so the resolved one is materialized as a
 *  required extension (seeded or `ext add`ed), failing loud if absent. The `-f` manifest launch
 *  preflights every type via `preflightConnectors`, and `--detach` resolves the connector
 *  manager-side, so both skip this.
 *
 *  #869: the persona file's `agent:` pin participates — flag > file > COTAL_DEFAULT_AGENT > default
 *  — but the pin is only knowable from the TARGET mesh's root, which `resolveTargetOrExit` owns and
 *  this pre-parse hook cannot reach without duplicating the five-tier target precedence. An earlier
 *  revision read the persona from the cwd walk here; that made a spawn from a cwd outside the
 *  target pre-materialize the WRONG connector, and a wrong pre-materialization hard-aborts the
 *  command (materializeExtension throws on an uninstalled extension) before the body ever loads
 *  the correct persona. The materialization is therefore DEFERRED into the spawn body, immediately
 *  after the authoritative persona load and before registry.resolve — one resolver, one root, and
 *  the hook stays root-free exactly as it was before #869. */
export function spawnRequiredExtensions(_args: ParsedArgs): readonly ExtensionRef[] {
  return [];
}

/** Comma-list flag → string[] (shared by both spawn modes). */
const splitFlag = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** #867: the name a spawn sends must already be a mintable identity, and the check must not wait
 *  for the manager's round trip. `spawnNameError` is the SAME predicate the manager applies at its
 *  door (manager.ts `start`), so the operator sees core's own refusal — offending character,
 *  reservation reason, and the `_` remedy — before any request leaves. A courtesy only: the
 *  manager door stays the enforcement point; this is why the CLI passes the target mesh's auth
 *  mode rather than restating the grammar (static mode keys the actor on the nkey, not the name). */
function refuseUnmintableNameOrExit(name: string, userMode: boolean): void {
  const refusal = spawnNameError(name, { userMode });
  if (refusal) {
    console.error(c.red(`✗ ${refusal}`));
    process.exit(1);
  }
}

/** The `--detach` mode: hand the launch to the running manager over the control plane. One grammar
 *  with the foreground path; the persona file is resolved (and is the access default) manager-side,
 *  overridden by the same flags, which ride the `start` op. Replaces the removed `cotal start`. */
async function spawnDetached(
  values: FlagValues<typeof spawnFlags>,
  positionals: string[],
  events: boolean | undefined,
  launchOptions: Record<string, string> | undefined,
): Promise<void> {
  // WHICH file the manager loads — the exact foreground precedence (`--config` > positional >
  // `COTAL_DEFAULT_PERSONA` > `default`). Identity is separate:
  // when `--name` is given it OVERRIDES the file's `name:` (foreground's `requested`), threaded
  // as the op's `identity` so it is never silently dropped in detached mode.
  const defaultPersona = defaultPersonaOverride();
  const ref = spawnPersonaRef(values.config, positionals);
  const managerConfigRef = values.config ?? (!positionals[0] && defaultPersona ? ref : undefined);
  const on = onInstanceOrExit(values.on, "cotal spawn <persona> --detach");
  // From a managed seat's own shell the launch is the SEAT's, as its `cotal_spawn` tool is: the
  // manager records the seat as the spawner, so the seat can stop the child it asked for (#718).
  // `--on` keeps the pin on that path too.
  const flags = { space: values.space, server: values.server, creds: values.creds };
  const t = (values.creds === undefined ? await resolveSeatControlTarget(flags, on) : undefined)
    ?? await resolveControlTarget(flags, "control-caller-privileged", on);
  let policy: typeof t.policy;
  try {
    policy = await refreshRegistrationPolicy(t);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  // #867: refuse an unmintable identity BEFORE the round trip. On this path the persona is
  //  resolved manager-side, so the effective identity is `--name` alone — when it is absent the
  //  manager applies the same spawnNameError to the file's `name:` at its own door.
  if (values.name !== undefined) refuseUnmintableNameOrExit(values.name, t.mode === "user");
  const eventsRequired = policy?.events === "required";
  if (eventsRequired && events === false) {
    console.error(c.red(`✗ space "${t.space}" requires the event plane by registration policy; --no-events is not allowed`));
    process.exit(1);
  }
  provenance.read("mesh", `${t.space} (${t.server})`);
  let resumeAgent: string | undefined;
  let resumeClaim: string | undefined;
  if (values.resume !== undefined) {
    resumeAgent = resolveAgentType({ flag: values.agent });
    resumeClaim = await carryTranscriptOrExit(flags, on, values.resume, resumeAgent);
  }
  console.error(c.dim("waiting for it to join the mesh (the manager replies on a real outcome - join, exit, or ~30s) …"));
  const reply = await askManager(t.space, t.server, "start", {
    name: ref,
    identity: values.name,
    role: values.role,
    // #869: keep an explicit `--agent` and the invoking operator's COTAL_DEFAULT_AGENT in separate
    // fields. Collapsing them made the env default indistinguishable from a flag, so it beat the
    // persona pin; dropping the env instead changed detached semantics whenever the manager's own
    // environment differed. The manager applies flag > file > caller default > manager default.
    agent: values.agent,
    defaultAgent: defaultAgentOverride(),
    config: managerConfigRef,
    model: values.model,
    variant: values.variant,
    launchOptions,
    cwd: values.cwd,
    resume: values.resume, // host-local session id; the manager preflights connector resume support
    ...(resumeClaim !== undefined ? { resumeClaim, resumeAgent } : {}),
    prompt: values.prompt,
    shareTools: parseShareSelection(values["share-tools"]),
    subscribe: splitFlag(values.subscribe),
    allowSubscribe: splitFlag(values["allow-subscribe"]),
    allowPublish: splitFlag(values["allow-publish"]),
    // #373: send the bit only when the operator chose it. On an events-required space the
    // policy still forces the plane on (the manager refuses a non-admin caller on such a space
    // anyway, so the operator must hold the admin tier for the spawn to succeed at all).
    events: eventsRequired ? true : events,
    // #159 B1: the manager replies only on a REAL outcome (presence join / process exit / ~30s
    // readiness backstop) — the start request must outlive that window, not the 5s op default.
    // `--on <instance>` pins the spawn to that exact manager instance (P2 item 3 multi-manager).
  }, t.auth, "owner", START_TIMEOUT_MS, { instanceId: on });
  failIfNotOk(reply);
  const d = reply.data as { name: string; role?: string; agent: string; mode: string; eventsNotice?: string };
  if (d.eventsNotice) console.log(c.yellow(`! ${d.eventsNotice}`));
  console.log(
    c.green(`✓ spawned ${c.bold(d.name)} (detached)`) +
      c.dim(` (${d.role ?? "no role"} · ${d.agent} · ${d.mode}) - attach with: cotal attach --name ${d.name}`),
  );
}

/**
 * Carry a session this host holds to the manager instance a detached resume launches on, and return
 * the claim its `spawn` names (#1499, docs/design/resume-transfer.md section 2). Undefined when this
 * host holds no session `id`: the id then resolves on the manager's host as it always has. Only the
 * connector can tell a local session from one that lives on the manager's host, so a connector this
 * CLI cannot load is refused.
 */
async function carryTranscriptOrExit(flags: ConnectFlags, on: string | undefined, id: string, agent: string): Promise<string | undefined> {
  let found: { path: string; title?: string } | undefined;
  try {
    await materializeExtension({ kind: "connector", name: agent });
    found = registry.resolve<Connector>("connector", agent).resumeTranscript?.find(id, process.env);
  } catch (e) {
    console.error(c.red(`✗ resume: ${(e as Error).message}`));
    process.exit(1);
  }
  if (found === undefined) return undefined;
  if (on === undefined) {
    console.error(c.red(`✗ resume: session ${id} is held on this host, and carrying it needs one manager instance; pass --on <instance>`));
    process.exit(1);
  }
  const bytes = readFileSync(found.path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const t = await resolveControlTarget(flags, "control-caller-admin", on);
  const bucket = transferBucket(t.space, on);
  const writer = await transferWriterOrExit(flags, t, on, sha256);
  let sent = 0;
  let chunks = 0;
  for (;;) {
    const reply = await askManager(t.space, t.server, "transcriptReceive", {
      sha256, size: bytes.length, source: id, sourceHost: hostname(), ...(found.title ? { title: found.title } : {}),
    }, t.auth, "owner", undefined, { instanceId: on });
    failIfNotOk(reply);
    const answer = reply.data as { state: "upload" } | { state: "staged"; claim: string };
    if (answer.state === "staged") {
      console.log(c.dim(`carried session ${id} to ${on}: sha256:${sha256}, ${sent} of ${bytes.length} bytes sent in ${chunks} chunks`));
      return answer.claim;
    }
    const pass = await withControlConnection(t.server, writer, (nc) => writeTransfer(nc, bucket, bytes));
    sent += pass.sent;
    chunks += pass.chunks;
  }
}

/** The transfer writer instrument for one object in one instance's bucket (design section 6), once
 *  the transcript is hashed: minted from this host's copy of the mesh's signing seed, or on a
 *  user-auth mesh exchanged from the operator's login as a `transfer-writer` view. An open mesh
 *  enforces no grants, so a bare connection writes there. */
async function transferWriterOrExit(flags: ConnectFlags, t: ControlTarget, instanceId: string, hex: string): Promise<ControlAuth> {
  if (t.mode === "open") return { tls: t.auth.tls };
  if (t.mode === "user") {
    const conn = await connectUserControlOrExit(flags);
    try {
      const view = await userViewAuth(conn, "transfer-writer", { transferWriter: { instanceId, hex } });
      return { bearer: view.bearer, sentinelCreds: view.sentinelCreds, tls: conn.tls };
    } catch (e) {
      console.error(c.red(`✗ resume: ${(e as Error).message}`));
      process.exit(1);
    }
  }
  if (t.mode !== "auth" || !t.spaceAuth) {
    console.error(c.red("✗ resume: carrying a session mints a transfer writer from this mesh's signing seed, and this host holds none for it (an off-registry connection)"));
    process.exit(1);
  }
  return { creds: await mintCreds(t.spaceAuth, newIdentity(), "transfer-writer", { transferWriter: { instanceId, hex } }), tls: t.auth.tls };
}

/**
 * `cotal spawn <name-or-path>` — launch an agent in the FOREGROUND of this
 * terminal from a local agent file, joined to the mesh with its persona.
 *
 * With `--detach` the manager spawns it into a detached PTY you `cotal attach` to;
 * otherwise `cotal spawn` hands THIS terminal straight to the agent: run it in your
 * shell, or inside a cmux/tmux pane, and the real Claude TUI takes over. One grammar,
 * two run modes.
 *
 * The launch recipe is the connector's `buildLaunch` (the single source of truth,
 * shared with the manager); only *how the spec runs* differs — foreground exec
 * here vs. a supervised runtime in the manager. The connector is resolved from
 * the registry by agent type, composed at the root.
 *
 * The mesh it joins — creds and personas together — is resolved by {@link resolveMeshTarget}, so a
 * bare `cotal spawn <persona>` from any directory finds the running mesh (one up, or the `current`
 * default) instead of mistaking `~/.cotal` for a space.
 */
export async function spawn(args: ParsedArgs): Promise<void> {
  const positionals = args.positionals;
  const values = args.values as FlagValues<typeof spawnFlags>;
  // Claimed first: custody already removed the file and its variable, so the text lives only here
  // and no refusal below can leave it anywhere.
  const handoffText = claimManagedHandoff();
  let enrollmentUrl: string | undefined;
  try {
    enrollmentUrl = enrollmentInput();
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  } finally {
    // The URL is the credential. Keep the local value, but remove both input forms before this
    // command can start extension, bearer-preflight, or harness children.
    scrubEnrollmentEnv(process.env);
  }
  let redeemedEnrollment: ReturnType<typeof checkEnrollmentBundle> | undefined;
  if (handoffText === undefined && (values["expect-owner"] !== undefined || values["expect-lifecycle-uid"] !== undefined)) {
    console.error(c.red(`✗ --expect-owner and --expect-lifecycle-uid apply only with ${MANAGED_HANDOFF_FILE_ENV}`));
    process.exit(1);
  }
  if (handoffText !== undefined) {
    const refusal =
      enrollmentUrl ? `${MANAGED_HANDOFF_FILE_ENV} cannot be combined with ${ENROLLMENT_URL_ENV}/${ENROLLMENT_FILE_ENV}`
      : values.detach || values.file || values.creds ? `${MANAGED_HANDOFF_FILE_ENV} applies only to a foreground persona spawn without --creds`
      : !values.space || !values.name || !values["expect-owner"] || !values["expect-lifecycle-uid"]
        ? `${MANAGED_HANDOFF_FILE_ENV} requires --space, --name, --expect-owner and --expect-lifecycle-uid`
      : !values.config ? `${MANAGED_HANDOFF_FILE_ENV} requires --config <persona-file>`
      : undefined;
    if (refusal) {
      console.error(c.red(`✗ ${refusal}`));
      process.exit(1);
    }
    try {
      loadAgentFile(resolvePath(values.config!));
    } catch (e) {
      console.error(c.red(`✗ cannot load the managed handoff persona: ${(e as Error).message}`));
      process.exit(1);
    }
    try {
      const handoff = parseManagedLifecycleHandoff(handoffText, {
        space: values.space!, owner: values["expect-owner"]!, actor: values.name!, lifecycleUid: values["expect-lifecycle-uid"]!,
      });
      try {
        spaceKey(handoff.space);
      } catch {
        throw new Error(HANDOFF_REFUSALS.space);
      }
      const { bundle, stock } = handoffEnrollmentBundle(handoff);
      redeemedEnrollment = { bundle, stock };
      let registered: boolean;
      try {
        registered = findMesh(handoff.space) !== undefined;
      } catch {
        throw new Error(HANDOFF_REFUSALS.registration);
      }
      if (!registered) await registerEnrollmentMesh(stock, resolvePath(values.config!, ".."), HANDOFF_REFUSALS);
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }
  if (enrollmentUrl && (values.detach || values.file)) {
    console.error(c.red(`✗ ${ENROLLMENT_URL_ENV}/${ENROLLMENT_FILE_ENV} apply only to a foreground persona spawn`));
    process.exit(1);
  }
  if (enrollmentUrl && !values.space) {
    console.error(c.red(`✗ ${ENROLLMENT_URL_ENV}/${ENROLLMENT_FILE_ENV} require --space <s>`));
    process.exit(1);
  }
  const enrollmentBootstrap = Boolean(enrollmentUrl && values.space && !findMesh(values.space));
  if (enrollmentBootstrap) {
    if (!values.config || (!values.config.includes("/") && !values.config.includes("\\") && !values.config.endsWith(".md"))) {
      console.error(c.red("✗ enrollment bootstrap needs --config <persona-file>; no remote persona catalog exists on this machine yet"));
      process.exit(1);
    }
    try {
      loadAgentFile(resolvePath(values.config));
    } catch (e) {
      console.error(c.red(`✗ cannot load the enrollment bootstrap persona: ${(e as Error).message}`));
      process.exit(1);
    }
  }

  // `spawn -f cotal.yaml` is a distinct path: deploy a manifest onto a RUNNING mesh (additive,
  // ownership-scoped). The broker must already be reachable; bringing up a fresh mesh is `up -f`.
  // `--on` is read only by the detached imperative launch. A foreground spawn runs the connector in
  // this process (no manager to pin), and a manifest deploy launches every agent through the
  // manager class queue (`spawnManifest` takes no instance). Both would have to ignore the flag;
  // an ignored pin is a silent fallback, so refuse it where it cannot apply, as `--dry-run` is.
  if (values.on !== undefined && (!values.detach || values.file)) {
    console.error(c.red("✗ --on only applies to a detached imperative spawn (`cotal spawn <persona> --detach --on <instance>`); a foreground spawn has no manager to pin and a manifest deploy (-f) launches through the manager class queue"));
    process.exit(1);
  }
  if (values.file) {
    await spawnManifest(values.file, {
      dryRun: Boolean(values["dry-run"]),
      server: values.server,
      space: values.space,
      runtime: values.runtime,
      allowStale: splitFlag(values["allow-stale"]),
    });
    return;
  }
  // `--resume ""` / `--resume=` means the operator asked to resume but named no session — fail loud
  // rather than silently spawn a fresh one (no fallbacks). An absent flag (undefined) is fine.
  if (values.resume !== undefined && !values.resume.trim()) {
    console.error("--resume needs a session id (got an empty value)");
    process.exit(1);
  }
  if (values.variant !== undefined && !values.variant.trim()) {
    console.error("--variant needs a variant name (got an empty value)");
    process.exit(1);
  }
  // `--dry-run` is a manifest-only flag (`-f`): on an imperative spawn it would have to be ignored
  // (and once WAS, silently spawning a real agent) — refuse instead.
  if (values["dry-run"]) {
    console.error(c.red("✗ --dry-run only applies to a manifest deploy (`cotal spawn -f <manifest> --dry-run`)"));
    process.exit(1);
  }
  // Parse `--opt k=v` pairs once, up front — a malformed pair fails loud before either launch path
  // (foreground or detached) does any work. The opaque map is core-agnostic; the connector validates.
  let cliLaunchOptions: Record<string, string> | undefined;
  try {
    cliLaunchOptions = parseLaunchOptions(values.opt);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
  // The AG-UI event plane is ON by default. `--events` still forces on; `--no-events` is the only
  // opt-out. The flag ARMS the emitter; the manager separately
  // grants publish on the channel the connector names. Both are required, which is what stops a
  // hand-written grant from turning events on by itself.
  if (values.events && values["no-events"]) {
    console.error(c.red("✗ --events and --no-events are mutually exclusive"));
    process.exit(1);
  }
  // #373: the detached path sends the bit ONLY when the operator chose it. `--events` gives
  // true, `--no-events` gives false, neither gives undefined — the manager's spawn gate treats
  // an explicit true from a non-admin caller as operator reach and serves an omission unarmed
  // with a notice, so an unconditional default-true would be refused for an ordinary actor.
  const events = values.events ? true : values["no-events"] ? false : undefined;

  // `--detach`: the SAME grammar, launched by the manager into a detached PTY. The persona is
  // resolved manager-side (its workspace root owns `.cotal/agents`); flags ride the control
  // request and override the file exactly as the foreground path does.
  if (values.detach) {
    return spawnDetached(values, positionals, events, cliLaunchOptions);
  }
  // `--creds` names a CONTROL-CALLER credential (reach an off-registry manager) — meaningless for
  // a foreground launch, which provisions the agent's own creds. Fail loud, never ignore.
  if (values.creds) {
    console.error(c.red("✗ --creds is only valid with --detach (it authenticates the manager control call)"));
    process.exit(1);
  }

  // An enrollment may bootstrap the stock remote user-mesh record before normal target resolution.
  // Redeem only when the named space is not registered; an existing entry defers redemption until
  // after persona resolution so the response actor can be checked against the requested identity.
  if (enrollmentBootstrap) {
    let provider: ReturnType<typeof resolveAuthProvider>;
    try {
      provider = resolveAuthProvider();
      if (!provider.postAgentEnrollment)
        throw new Error(`the registered auth provider "${provider.name}" cannot redeem remote agent enrollments`);
      const body = await provider.postAgentEnrollment({ url: enrollmentUrl! });
      const actor = typeof (body as { actor?: unknown })?.actor === "string" ? (body as { actor: string }).actor : "";
      if (!actor) throw new Error("the enrollment endpoint returned no actor - it cannot launch this seat");
      redeemedEnrollment = checkEnrollmentBundle(body, actor);
      if (redeemedEnrollment.bundle.space !== values.space)
        throw new Error(`the enrollment is for space "${redeemedEnrollment.bundle.space}" but --space names "${values.space}"`);
      if (!redeemedEnrollment.stock)
        throw new Error("space is not registered and the enrollment bundle carries no stock { server, tlsRequired, userAuth } mesh material");
      await registerEnrollmentMesh(redeemedEnrollment.stock, resolvePath(values.config!, ".."));
    } catch (e) {
      console.error(c.red(`✗ ${(e as Error).message}`));
      process.exit(1);
    }
  }

  // Which mesh this spawn joins — creds + personas together, resolved from --server/--space, the
  // selected `current` mesh, a local project, or the registry's only running mesh. A handoff's
  // resolution diagnostics quote its space, and only a remote user-auth record can host the
  // lifecycle it carries, so any other record is refused before a later step reads it.
  const target = handoffText === undefined
    ? await resolveTargetOrExit({ server: values.server, space: values.space })
    : await resolveTargetOrThrow({ server: values.server, space: values.space }).catch(() => {
      console.error(c.red(`✗ ${HANDOFF_REFUSALS.target}`));
      process.exit(1);
    });
  if (handoffText !== undefined && !(target.mode === "user" && target.userAuth?.remote)) {
    console.error(c.red("✗ the managed handoff's space is registered here as a local mesh, so it cannot host a managed handoff"));
    process.exit(1);
  }
  let policy: typeof target.policy;
  try {
    policy = await refreshRegistrationPolicy(target);
  } catch (e) {
    console.error(c.red(`✗ ${handoffText === undefined ? (e as Error).message : HANDOFF_REFUSALS.policy}`));
    process.exit(1);
  }
  const eventsRequired = policy?.events === "required";
  // A handoff's space is a value from the document, so its policy refusals name the field instead.
  const policySpace = handoffText === undefined ? `space "${target.space}"` : "the managed handoff's space";
  if (eventsRequired && values["no-events"]) {
    console.error(c.red(`✗ ${policySpace} requires the event plane by registration policy; --no-events is not allowed`));
    process.exit(1);
  }
  // Foreground is the operator's own in-process launch (no typed door, no epAdminReach) and is
  // NOT gated: it keeps the default-on plane. `events` is now a tri-state (undefined when the
  // operator passed neither flag), so default it on here the way the old boolean did.
  const launchEvents = eventsRequired || events !== false;
  const { space, server, auth } = target;
  const composition = { injected: false as const, root: target.root };

  const defaultPersona = defaultPersonaOverride();
  // Where the config lives: --config, else the positional <persona>, else COTAL_DEFAULT_PERSONA
  // (.cotal/agents/<name>.md under the TARGET mesh's root). With none, fall back to its `default`
  // persona — `cotal spawn` with no args launches `<root>/.cotal/agents/default.md`.
  const ref = spawnPersonaRef(values.config, positionals);
  const path = redeemedEnrollment && values.config ? resolvePath(values.config) : agentFilePath(target.root, ref);
  let def: AgentDef;
  try {
    def = loadAgentFile(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // The not-found text names the mesh's space and server, which for a handoff are its values.
    if (handoffText !== undefined) {
      console.error(c.red(`✗ cannot load the managed handoff persona: ${(e as Error).message}`));
    } else if (code === "ENOENT") {
      // A refusal that names no root is why this bug cost an hour. The old text asserted an absence
      // ("no default persona yet") and prescribed a remedy (`cotal setup`) without saying WHERE it
      // had looked — so when setup seeded a cwd-derived root and spawn read the resolved mesh's,
      // the message survived running the exact command it named and pointed at nothing to check.
      // Name the absolute directory checked and the mesh that root came from: the two facts that
      // make the disagreement visible in one read.
      const where = `${target.personaRoot} (mesh "${target.space}" at ${target.server}${target.source === "current" ? ", your current mesh" : target.source === "registry" ? ", the only mesh running" : ""})`;
      console.error(
        c.red(
          ref === "default" && !defaultPersona
            ? `✗ no default persona in ${where} - run \`cotal setup\` here to seed one into that directory, or name a persona: \`cotal spawn <name>\``
            : `✗ no persona "${ref}"${!values.config && !positionals[0] && defaultPersona ? " from COTAL_DEFAULT_PERSONA" : ""} in ${where} - pass a catalog name, or use \`--config <path>\` for a file elsewhere`,
        ),
      );
    } else {
      console.error(c.red(`✗ ${(e as Error).message}`));
    }
    process.exit(1);
  }

  // Provenance: say which persona file WON resolution (--config > positional > COTAL_DEFAULT_PERSONA > default)
  // — the user must never wonder which directory their agent's definition came from.
  provenance.read("persona", path);

  // --name / --role override the file (name defaults from the file's frontmatter).
  const requested = values.name ?? def.name;
  const role = values.role ?? def.role;
  // Flags win over the file, resolved once: the model policy below judges these values and the
  // connector launches on them. Left to the connector, the model is re-read from the persona at
  // launch, after the check, so an edit in between would launch a model the policy never saw.
  const model = values.model ?? def.model;
  const variant = values.variant ?? def.variant;
  // Opaque connector options: `--opt` flags win per key over the persona's `launchOptions:`.
  const launchOptions = mergeLaunchOptions(def.launchOptions, cliLaunchOptions);
  if (redeemedEnrollment && redeemedEnrollment.bundle.actor !== requested) {
    console.error(c.red(`✗ the enrollment is for actor "${redeemedEnrollment.bundle.actor}" but this spawn names "${requested}"`));
    process.exit(1);
  }
  // #867: same door as the detached path — the effective identity (flag or file) must be mintable
  //  before any provision work; core's own refusal names the offender and the `_` remedy.
  refuseUnmintableNameOrExit(requested, target.mode === "user");
  // #581: the same per-role model allowlist the manager enforces on a detached spawn, judged on the
  // effective role, model (flag over file) and launch options before anything is provisioned or launched.
  try {
    const refusal = modelPolicyRefusal(loadCotalConfig(target.root), {
      persona: `persona "${ref}" (${path})`,
      role, model, variant,
      modelFlag: values.model !== undefined,
      variantFlag: values.variant !== undefined,
      launchOptions,
    });
    if (refusal) {
      console.error(c.red(`✗ ${refusal}`));
      process.exit(1);
    }
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }

  // Preflight: fail with one sentence if the mesh is down or won't take our creds, instead of
  // crashing mid-connect with a raw NATS Authorization Violation.
  if (handoffText === undefined) await preflightOrExit(target);
  else
    await preflightOrThrow(target).catch(() => {
      console.error(c.red(`✗ ${HANDOFF_REFUSALS.preflight}`));
      process.exit(1);
    });

  // A second `cotal spawn` of the same agent would otherwise join under a duplicate mesh identity:
  // auto-number the name past anyone already present (best-effort — this path bypasses the manager's
  // race-free reservation; see uniqueMeshName). Everything below (creds path, launch) uses `name`.
  // USER mesh: the advisory presence read has no credential to ride (no static mint — U10), so the
  // requested name stands; a same-name respawn ROTATES that actor's grant (upsert), which kills the
  // previous holder's next bearer refresh with the "secret is stale — respawn" health state rather
  // than aliasing it silently.
  const name = target.mode === "user" ? requested : await uniqueMeshName(requested, { space, server, auth });
  if (name !== requested)
    console.error(`"${requested}" is already on the mesh - spawning as ${name} instead`);

  // When the target was auto-resolved (one mesh up, or the `current` default), say which mesh we
  // picked — it isn't obvious from the cwd. An explicit --space/--server or a local project is
  // self-evident, so stay quiet there.
  if (target.source === "registry" || target.source === "current")
    console.error(c.dim(`→ joining mesh ${space} (${server}) as ${name}`));

  const agentType = resolveAgentType({ flag: values.agent, pin: def.agent });
  // Materialize the connector HERE, after the authoritative persona load (#869): the harness choice
  // (flag > persona pin > env > default) is only final once the target root has supplied the file.
  // On the published binary nothing static-imports connectors, so this import-from-manifest is what
  // puts the chosen one in the registry before the resolve below; an uninstalled connector fails
  // loud with its install hint. Doing this in `spawnRequiredExtensions` (pre-parse, pre-target)
  // instead would need a SECOND root resolution that can disagree with this one — the regression a
  // cold read of this PR caught — so the hook stays root-free and the materialization lives here.
  try {
    await materializeExtension({ kind: "connector", name: agentType });
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  let connector: Connector;
  try {
    connector = registry.resolve<Connector>("connector", agentType);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  if (variant && !connector.supportsModelVariant) {
    console.error(c.red(`✗ ${agentType} connector does not support model variants (variant)`));
    process.exit(1);
  }
  if (values.prompt !== undefined && !connector.supportsPrompt) {
    console.error(c.red(`✗ ${agentType} connector does not support an initial prompt (prompt)`));
    process.exit(1);
  }

  // Auth mode (`.cotal/auth` present): mint a stable identity + scoped creds for this agent
  // and pre-create its bind-only durables, via a short-lived privileged provisioner — the
  // same onboarding the manager does, so the foreground launch joins the authed mesh too.
  // Open mode (no `.cotal/auth`): the session connects without creds, under an allocated id.
  let id: string | undefined;
  let credsPath: string | undefined;
  // The incarnation's lifecycle UID (SPEC 13.1), minted once per spawn: the launched endpoint binds
  // its lifecycle-keyed dm/dlv/chathist durables by it (auth modes pin the same names in the cred;
  // open mode still needs it for the durable names). A foreground spawn is one lifecycle. `let`
  // because a REMOTE provisioning replaces it below: the mesh minted that incarnation, and its
  // durables and ledger row are keyed on ITS uid — a locally minted one can never match them.
  let lifecycleUid = mintLifecycleUid();
  let userAuth: LaunchOpts["userAuth"];
  // Which user-auth arm produced `userAuth`: the REMOTE provisioning path (an enrollment or the
  // advertised endpoint) or the local provider. The departure sentence below names what THAT arm's
  // cleanup actually does (#1837): the local arm's cleanup revokes the row, the remote arm's
  // shreds only this machine's credential files and leaves the mesh-side grant standing.
  let remoteUserAuth = false;
  let userCleanup: (() => Promise<void>) | undefined;
  // The agent's access policy (flags > persona file) — minted into the creds AND forwarded to the
  // connector (COTAL_SUBSCRIBE / COTAL_ALLOW_*) so the session's runtime read/post set matches its
  // credentials. One source, so a `--subscribe` override can't land in the creds yet be lost at
  // runtime (the connector would otherwise read only the persona file and miss the override).
  let subscribe = splitFlag(values.subscribe) ?? def.subscribe;
  let allowSubscribe: string[];
  try {
    allowSubscribe = resolveReadAcl(subscribe ?? [], splitFlag(values["allow-subscribe"]) ?? def.allowSubscribe);
  } catch (e) {
    console.error(c.red(`✗ ${(e as Error).message}`));
    process.exit(1);
  }
  let allowPublish = splitFlag(values["allow-publish"]) ?? def.allowPublish;
  // The AG-UI event plane, refused HERE for the same reason the manager refuses it before
  // provisioning: a connector that cannot emit must stop the launch while there is still nothing to
  // roll back. The GRANT cannot be derived yet, because it is keyed on the principal and in user
  // mode the owner is resolved inside the provisioning call below.
  if (launchEvents && !connector.eventChannel) {
    console.error(c.red(eventsRequired
      ? `✗ ${policySpace} requires the event plane by registration policy, but connector "${connector.name}" does not publish one`
      : `✗ connector "${connector.name}" does not publish an AG-UI event plane; pass --no-events to launch it without one`));
    process.exit(1);
  }
  // A REMOTE user mesh (registered with `meshes add --from`) that advertises a provisioning
  // endpoint: the mesh grants the row and pre-creates the durables inside the owner's envelope,
  // because the material to do that locally — the space's owner secret and account signer — only
  // exists where the mesh runs. Checked BEFORE the local user branch, whose first act would be to
  // ask for exactly that absent material and refuse.
  const remoteProvisioningUrl = target.mode === "user" && target.userAuth?.remote
    ? target.userAuth.endpoints?.agentProvisioningUrl
    : undefined;
  if (target.mode === "user" && target.userAuth?.remote && !remoteProvisioningUrl && !enrollmentUrl && !redeemedEnrollment) {
    console.error(c.red(`✗ mesh "${target.space}" runs elsewhere and advertises no agent-provisioning endpoint, so agents cannot be provisioned from this machine`));
    console.error(c.dim(`  a user-mode agent's credentials are granted where the mesh's signer lives; ask the mesh operator to advertise one (\`cotal up --agent-provisioning-url …\`), or run the agent there`));
    process.exit(1);
  }
  if (target.mode === "user" && target.userAuth?.remote && (enrollmentUrl || redeemedEnrollment)) {
    if (!redeemedEnrollment) {
      try {
        const provider = resolveAuthProvider();
        if (!provider.postAgentEnrollment)
          throw new Error(`the registered auth provider "${provider.name}" cannot redeem remote agent enrollments`);
        const body = await provider.postAgentEnrollment({ url: enrollmentUrl!, idpUrl: target.userAuth.idp.url });
        redeemedEnrollment = checkEnrollmentBundle(body, name);
      } catch (e) {
        console.error(c.red(`✗ ${(e as Error).message}`));
        process.exit(1);
      }
    }
    const enrolled = redeemedEnrollment.bundle;
    if (enrolled.space !== space) {
      console.error(c.red(`✗ the enrollment is for space "${enrolled.space}" but this spawn targets "${space}"`));
      process.exit(1);
    }
    if (enrolled.idp.url !== target.userAuth.idp.url || enrolled.idp.issuer !== target.userAuth.idp.issuer || enrolled.idp.audience !== target.userAuth.idp.audience) {
      console.error(c.red("✗ the enrollment's IdP pins do not match the registered mesh"));
      process.exit(1);
    }
    if (target.userAuth.endpoints?.url !== enrolled.authServiceUrl) {
      console.error(c.red("✗ the enrollment's authServiceUrl does not match the registered mesh exchange"));
      process.exit(1);
    }
    const remote = await provisionRemoteUserForeground(target, name, { body: enrolled, exchangeUrl: enrolled.authServiceUrl },
      handoffText === undefined ? undefined : HANDOFF_REFUSALS);
    userAuth = remote.userAuth;
    userCleanup = remote.cleanup;
    remoteUserAuth = true;
    if (remote.material.subscribe) subscribe = remote.material.subscribe;
    if (remote.material.allowSubscribe) allowSubscribe = remote.material.allowSubscribe;
    if (remote.material.allowPublish) allowPublish = remote.material.allowPublish;
    lifecycleUid = remote.material.lifecycleUid;
  } else if (remoteProvisioningUrl) {
    const remote = await provisionRemoteUserForeground(target, name, { provisioningUrl: remoteProvisioningUrl });
    userAuth = remote.userAuth;
    userCleanup = remote.cleanup;
    remoteUserAuth = true;
    // The mesh's grant is the authority on what this agent may read and post; the launch forwards
    // it verbatim so the session's runtime set matches the credentials it was actually issued.
    // A local --subscribe that the mesh did not grant would be a lie told to the connector.
    if (remote.material.subscribe) subscribe = remote.material.subscribe;
    if (remote.material.allowSubscribe) allowSubscribe = remote.material.allowSubscribe;
    if (remote.material.allowPublish) allowPublish = remote.material.allowPublish;
    // Same authority rule for the incarnation uid: the mesh provisioned the durables and wrote the
    // ledger row keyed on THIS uid, and the auth callout mints the agent's dm/dlv/chathist grants
    // from the row. Launching with the locally minted uid instead leaves the agent asking for
    // durables its credential does not name — an endless bind/violation loop, not a clean refusal.
    lifecycleUid = remote.material.lifecycleUid;
  } else if (target.mode === "user") {
    // USER mesh: the agent runs as a ledger-granted (owner, actor) principal under the LOGGED-IN
    // operator's owner — never a static identity (U10). Provisioning + grant + a one-shot bearer
    // preflight all happen BEFORE launch, so the spawned agent is never the first to discover a
    // dead auth plane.
    let eventGrant: string | undefined;
    ({ userAuth, cleanup: userCleanup, eventChannel: eventGrant } = await provisionUserForeground(target, name, ref, {
      subscribe,
      allowSubscribe,
      allowPublish,
      role,
      capabilities: def.capabilities,
      lifecycleUid,
      liveOnly: values["live-only"] as boolean | undefined,
      ...(launchEvents ? { eventChannel: connector.eventChannel! } : {}),
    }));
    // The launch's post-set is forwarded to the session as COTAL_ALLOW_PUBLISH, so it has to carry
    // whatever was actually minted. Letting the two diverge is how an agent ends up holding a right
    // its own runtime does not know it has.
    if (eventGrant) allowPublish = [...(allowPublish ?? []), eventGrant];
  } else if (auth) {
    const identity = newIdentity();
    // THE EVENT GRANT, from the principal this spawn ALLOCATED. Static mode keys on the nkey, never
    // on the display name: a name is not an identity, and the manager derives the same subject from
    // the same connector function, so a foreground and a detached spawn of one persona land on one
    // channel rather than two.
    if (launchEvents) allowPublish = [...(allowPublish ?? []), connector.eventChannel!({ owner: DEV_OWNER, actor: identity.id })];
    const prov = new CotalEndpoint({
      space,
      servers: server,
      creds: await mintCreds(auth, newIdentity(), "provisioner"),
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      card: { name: "spawn-provisioner", role: "provisioner", kind: "endpoint" },
    });
    const reportStaticProvisioner = (e: Error) => console.error(`! provisioner: ${e.message}`);
    prov.on("error", reportStaticProvisioner);
    prov.on("warning", reportStaticProvisioner);
    await prov.start();
    // Foreground provisions the SAME durable footprint as `--detach` (DM/DLV durables + read-ACL
    // row): the daemon authorizes durable joins off the ACL row and leave is agent self-service, so
    // no managing host is required — and a silently live-only foreground agent permanently loses
    // every channel message posted while its connection blips (reconnect deliberately re-opens the
    // core-subs without re-backfill). `--live-only` opts back out; on a mesh with no delivery
    // daemon the boot join itself reports live-only, ACL row or not.
    const creds = await provisionAgent(prov, auth, identity, {
      subscribe,
      allowSubscribe,
      allowPublish,
      role,
      capabilities: def.capabilities,
      ...(values["live-only"] ? { durableMembership: false } : {}),
      lifecycleUid,
    });
    await prov.stop();
    // Store first (the source of truth), then materialize — the child's launch reads this FILE.
    // The CLI is the local FS composition (byte-identical), same posture as the manager's spawn.
    const secrets = workspaceSecretStore(target.root);
    credsPath = agentSecretFilePaths(target.root, space, name).creds;
    await secrets.put(agentCredsKey(space, name, composition), creds);
    await materializeSecretToFile(secrets, agentCredsKey(space, name, composition), credsPath);
    id = identity.id;
    provenance.wrote(`creds for ${name} (auth mode)`, credsPath);
  } else {
    // Without a declared id the endpoint self-mints a fresh actor per process, which no event
    // channel can name. The manager allocates one for every non-user launch, so this does too.
    id = newIdentity().id;
  }

  // Which of the operator's personal MCP servers to share with this agent: declared in the cotal
  // config (global ~/.config/cotal + the target mesh's .cotal), narrowed by an optional
  // --share-tools selection. Default (no config) is none — the connector launches isolated.
  const cotalConfig = loadCotalConfig(target.root);
  const mcpServers = connectorServers(cotalConfig, agentType, parseShareSelection(values["share-tools"]));
  // The operator's spawn-env policy travels the same route: absent means no extras (the OS
  // allow-list + operator knobs + connector-declared inputs), present means those names too.
  // Resolved HERE, like the servers above, because a connector never reads the config file itself.
  const envAllow = spawnEnvAllow(cotalConfig);

  // Auth mode provisions the identity + writes its creds to disk BEFORE the connector validates the
  // launch (e.g. `buildLaunch` throws on a rejected `--opt`) and before the child execs. The SAME
  // retirement serves a failed launch (rollback) and the normal foreground departure: each spawn
  // mints a fresh identity, so an exited agent's footprint (creds file, DM/DLV durables, ACL row)
  // is dead weight no future spawn reuses — mirror the manager's `deprovision` with an ephemeral,
  // target-pinned deprovisioner cred. Best-effort like the manager's (a SIGKILLed CLI can't run
  // it; the residue is the same class a crashed manager leaves). A no-op in open mode.
  let retired = false;
  const retireProvision = async (why: string): Promise<void> => {
    if (retired || !auth || !id || !credsPath) return;
    retired = true;
    // The store delete is the authoritative removal; the rmSync clears the FS materialization
    // (byte-identical locally). Best-effort-loud, like the broker teardown below.
    await workspaceSecretStore(target.root).delete(agentCredsKey(space, name, composition)).catch((e) =>
      console.error(`! retire: dropping ${name}'s cred from the secret store failed: ${(e as Error).message}`));
    rmSync(credsPath, { force: true });
    console.error(`  ↩ retired creds for ${name} (${why})`);
    try {
      const dc = await mintCreds(auth, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: id, lifecycleUid } });
      await deprovisionAgent({ servers: server, space, targetId: id, lifecycleUid, creds: dc });
    } catch (e) {
      console.error(`! retire: broker teardown for ${name} failed: ${(e as Error).message}`);
    }
  };

  // From here through a successful child launch, a THROW must undo whatever this spawn provisioned —
  // the user-mode actor grant (userCleanup) OR the static-auth creds + broker footprint
  // (retireProvision) — otherwise a buildLaunch/spawn rejection (unsupported resume/model/`--opt`,
  // a bad connector) leaves the just-granted identity standing. The planes are exclusive, so each
  // cleanup is a no-op in the other's mode.
  let child: ReturnType<typeof spawnProcess>;
  let spec: LaunchSpec;
  let artifacts: string[] | undefined;
  try {
    spec = connector.buildLaunch({
      space,
      name,
      role,
      id,
      creds: credsPath,
      userAuth,
      lifecycleUid,
      servers: server,
      configPath: path,
      model,
      variant,
      launchOptions,
      subscribe,
      allowSubscribe,
      allowPublish,
      prompt: values.prompt,
      // Fork an existing session into the mesh. `prompt + resume` is a supported combo (claude accepts
      // the positional prompt alongside `--resume … --fork-session`); an unsupported connector throws.
      resume: values.resume,
      events: launchEvents,
      eventsRequired,
      mcpServers,
      envAllow,
      // Where a connector that keeps per-agent local state roots it. The manager passes its own
      // workspace root here; the foreground path did not, so an armed session refused at launch
      // construction because its write-ahead log had nowhere to live that a later start would look.
      workspaceRoot: target.root,
    });
    artifacts = spec.artifacts;
    scrubEnrollmentEnv(spec.env);

    // What happens next belongs to the CONNECTOR: naming one harness's first-run gate for all of
    // them sends the operator looking for a prompt that never appears, and reads as a hang.
    console.error(
      `spawning ${name}${role ? ` (${role})` : ""} on the mesh${connector.launchHint ? ` - ${connector.launchHint}` : ""}`,
    );
    if (userAuth) {
      // The sentence names its own arm's departure (#1837). The LOCAL arm's cleanup revokes the
      // row (provisionUserForeground → provider.revokeAgent), so "revoked automatically" is true
      // there. The REMOTE arm's cleanup shreds only the local token/sentinel/health files; the
      // grant lives in the mesh's ledger, where this machine holds no authority to revoke it, so
      // the sentence says what does happen and names the one route that revokes it.
      const revokeNote = remoteUserAuth
        ? "(actor granted by the mesh; local credential files are removed when this process exits, and the grant stays until the mesh operator revokes it)"
        : "(actor granted; revoked automatically when this process exits)";
      console.error(c.dim(`  running as you: ${userAuth.owner}.${name} ${revokeNote}`));
    }
    // The child's watcher removes the launch's private files once it is gone, even if this process
    // is killed first (core launch-artifacts).
    const launched = reclaimWithChild(spec);
    child = spawnProcess(launched.command, launched.args, {
      stdio: "inherit",
      // P3: only the connector-declared env (OS allow-list + identity + named model key) — never
      // `...process.env`, so the operator's unrelated secrets don't bleed into the foreground agent.
      env: spec.env ?? {},
      // `--cwd` roots the agent at another folder/repo (launch-grammar parity with --detach); a
      // relative path resolves against the invoking shell's cwd. Omitted → inherit this cwd.
      cwd: values.cwd ? resolvePath(values.cwd) : undefined,
    });
  } catch (e) {
    // Launch construction / spawn threw AFTER provisioning — undo BOTH planes (each a no-op in the
    // other's mode): revoke the user-mode actor grant AND roll back the static-auth creds + footprint,
    // before rethrowing, so no standing grant survives a spawn that never started.
    if (userCleanup) await userCleanup().catch((err) => console.error(c.red(`✗ revoking ${name}'s actor grant: ${(err as Error).message}`)));
    await retireProvision("launch build failed");
    // The launch's private files (core launch-artifacts) go too: no child will read them.
    discardLaunchArtifacts(artifacts);
    throw e;
  }
  await new Promise<void>((resolve) => {
    child.on("error", (e) => {
      // The exec never started, so the just-provisioned static-auth identity is orphaned — roll it
      // back. (User-mode revoke runs unconditionally once this promise settles, below.)
      console.error(`✗ failed to launch ${spec.command}: ${e.message}`);
      void retireProvision("exec failed").finally(() => {
        process.exitCode = 1;
        resolve();
      });
    });
    child.on("exit", (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
  // STATIC MODE: the departure half of the run-scoped identity — the agent is gone and no future
  // spawn reuses this identity, so retire its creds + broker footprint now (the manager's despawn
  // deprovision, foregrounded). Best-effort: a SIGKILLed CLI can't run it, and that residue is the
  // same class a crashed manager leaves.
  await retireProvision("agent exited");
  // USER MODE: the runtime-grant invariant applies to the foreground departure too — the agent is
  // gone, so its standing mint authority (ledger row + secret files) goes with it. Best-effort
  // (a SIGKILLed CLI can't run this; the next same-name spawn's rotation is the backstop), loud
  // on failure, never blocking the exit code already set above.
  if (userCleanup) await userCleanup().catch((e) => console.error(c.red(`✗ revoking ${name}'s actor grant: ${(e as Error).message}`)));
  // The child has exited or never started, so nothing reads the launch's private files any more
  // (core launch-artifacts). A SIGKILLed CLI cannot run this; the child's watcher removes those.
  discardLaunchArtifacts(spec.artifacts);
}

/** What a remote mesh's agent-provisioning endpoint returns (U6 §2). The client validates every
 *  field it uses: this arrives over the network from a deployment, so a missing or wrong-typed
 *  piece must be a named refusal here, never an `undefined` written into a 0600 file. */
interface RemoteAgentMaterial {
  actor: string;
  owner: string;
  lifecycleUid: string;
  actorToken: string;
  sentinelCreds: string;
  subscribe?: string[];
  allowSubscribe?: string[];
  allowPublish?: string[];
}

/** Validate the provisioning response. Returns the material, or the refusal sentence. */
function checkRemoteAgentMaterial(v: unknown, actor: string): { ok: true; material: RemoteAgentMaterial } | { ok: false; message: string } {
  const o = v as Partial<RemoteAgentMaterial> & { exists?: boolean };
  const bad = (m: string): { ok: false; message: string } => ({ ok: false, message: m });
  if (o === null || typeof o !== "object") return bad("the mesh's agent-provisioning endpoint did not answer with a JSON object");
  // An idempotent "already exists" answer carries no material by design; it is not an error the
  // client can repair by retrying, so it gets its own sentence naming the flag that rotates.
  if (o.exists === true) return bad(`agent "${actor}" already exists on this mesh and its credentials were not reissued - spawn it under a different name, or ask the mesh operator to reissue it`);
  const str = (k: keyof RemoteAgentMaterial): string | undefined => (typeof o[k] === "string" && o[k] ? (o[k] as string) : undefined);
  for (const k of ["actor", "owner", "lifecycleUid", "actorToken", "sentinelCreds"] as const)
    if (!str(k)) return bad(`the mesh's agent-provisioning endpoint returned no ${k} - it cannot provision agents for this mesh`);
  const list = (k: "subscribe" | "allowSubscribe" | "allowPublish"): string[] | undefined =>
    Array.isArray(o[k]) && (o[k] as unknown[]).every((s) => typeof s === "string") ? (o[k] as string[]) : undefined;
  if (o.actor !== actor)
    return bad(`the mesh provisioned actor "${String(o.actor)}" for a request naming "${actor}" - refusing material that does not match what was asked for`);
  return {
    ok: true,
    material: {
      actor: o.actor!, owner: o.owner!, lifecycleUid: o.lifecycleUid!, actorToken: o.actorToken!, sentinelCreds: o.sentinelCreds!,
      ...(list("subscribe") ? { subscribe: list("subscribe") } : {}),
      ...(list("allowSubscribe") ? { allowSubscribe: list("allowSubscribe") } : {}),
      ...(list("allowPublish") ? { allowPublish: list("allowPublish") } : {}),
    },
  };
}

/** Foreground REMOTE-USER onboarding — the participant path for a mesh registered with
 *  `meshes add --from` that advertises an agent-provisioning endpoint (U6 §2).
 *
 *  The local twin below ({@link provisionUserForeground}) cannot run here and must not try: it
 *  needs the space's owner secret and account signer to grant a row and pre-create durables, and
 *  those never leave the machine the mesh runs on. Instead the mesh's own endpoint does that work
 *  inside the owner's delegation envelope and hands back ready material; this function's job is to
 *  present the login bearer, validate what comes back, land it 0600, and prove the bearer chain
 *  before launch — the same preflight discipline, with the grant performed remotely.
 *
 *  Deliberately NOT reusing the local path's cleanup: nothing here created broker state locally, so
 *  teardown is the mesh's business (its lifecycle owns the row and the durables). The spawned
 *  agent's material is shredded on exit; the row is not revoked from here, because this machine
 *  holds no authority to revoke it. For a managed handoff, `refusals` replaces the sentences of the
 *  local-state, material and bearer steps, which quote the space, the actor or the exchange URL. */
async function provisionRemoteUserForeground(
  target: MeshTarget,
  name: string,
  source: { provisioningUrl: string } | { body: unknown; exchangeUrl: string },
  refusals?: typeof HANDOFF_REFUSALS,
): Promise<{ userAuth: NonNullable<LaunchOpts["userAuth"]>; cleanup: () => Promise<void>; material: RemoteAgentMaterial }> {
  const { space } = target;
  const store = workspaceSecretStore(target.root);
  const composition = { injected: false as const, root: target.root };
  const fail = (msg: string): never => {
    console.error(c.red(`✗ ${msg}`));
    process.exit(1);
  };
  // Resolved first, as by every consumer of the space's local state: each resolution migrates a
  // pre-hex or root-scoped layout, or refuses an ambiguous one, before any request or material.
  let paths: ReturnType<typeof agentSecretFilePaths>;
  try {
    userAuthStateDir(target.root, space);
    paths = agentSecretFilePaths(target.root, space, name);
  } catch (e) {
    return fail(refusals?.registration ?? (e as Error).message);
  }
  let provider: ReturnType<typeof resolveAuthProvider>;
  try {
    provider = resolveAuthProvider();
  } catch (e) {
    return fail((e as Error).message);
  }
  let body: unknown;
  let exchangeUrl = target.userAuth?.endpoints?.url;
  if ("body" in source) {
    body = source.body;
    exchangeUrl = source.exchangeUrl;
  } else {
    const idpUrl = target.userAuth?.idp.url;
    if (!idpUrl) return fail(`mesh "${space}" records no IdP to sign in against - re-register it with \`cotal meshes add ${space} --from <url> --mode user\``);
    // The login proof rides the provisioning request, so the POST is the PROVIDER's (this package
    // never touches the session cache); its thrown sentences are already operator-exact — the
    // no-login gate names the `cotal login --idp …` line, a refusal carries the mesh's own reason.
    if (!provider.postAgentProvisioning)
      return fail(`the registered auth provider "${provider.name}" cannot provision agents on a remote mesh - run the agent where the mesh runs`);
    try {
      body = await provider.postAgentProvisioning({ url: source.provisioningUrl, idpUrl, actor: name });
    } catch (e) {
      return fail((e as Error).message);
    }
  }
  const checked = checkRemoteAgentMaterial(body, name);
  if (!checked.ok) return fail(refusals?.bundle ?? checked.message);
  const material = checked.material;
  const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = paths;
  try {
    // Land both secrets 0600 through the store, exactly as the local path does — the bearer
    // re-exec and the launch handoff read FILES.
    await store.put(agentActorTokenKey(space, name, composition), material.actorToken);
    await store.put(agentSentinelCredsKey(space, name, composition), material.sentinelCreds);
    await materializeSecretToFile(store, agentActorTokenKey(space, name, composition), tokenPath);
    await materializeSecretToFile(store, agentSentinelCredsKey(space, name, composition), sentinelPath);
    rmSync(healthPath, { force: true });
    provenance.wrote(`remote actor material ${material.owner}.${name} (user mode)`, tokenPath);
    // The bearer preflight — the same one-shot proof the local path runs, pointed at the pinned
    // exchange instead of a local service. A dead auth chain stops the spawn here.
    if (!exchangeUrl) return fail(`mesh "${space}" records no exchange endpoint - re-register it with \`cotal meshes add ${space} --from <url> --mode user\``);
    const bearerCmd = [
      process.execPath,
      ...process.execArgv,
      process.argv[1],
      provider.agentBearerCommand,
      "--exchange-url", exchangeUrl,
      "--space", space,
      "--owner", material.owner,
      "--actor", name,
      "--token-file", tokenPath,
      "--health-file", healthPath,
    ];
    await runBearerPreflight(bearerCmd);
    return {
      userAuth: { owner: material.owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd },
      material,
      // Local shred only. The remote row and its durables belong to the mesh's lifecycle; this
      // machine has no authority to retire them and must not pretend otherwise.
      cleanup: async () => {
        await store.delete(agentActorTokenKey(space, name, composition)).catch(() => {});
        await store.delete(agentSentinelCredsKey(space, name, composition)).catch(() => {});
        rmSync(tokenPath, { force: true });
        rmSync(sentinelPath, { force: true });
        rmSync(healthPath, { force: true });
      },
    };
  } catch (e) {
    let cause = e as Error;
    try {
      await store.delete(agentActorTokenKey(space, name, composition)).catch(() => {});
      await store.delete(agentSentinelCredsKey(space, name, composition)).catch(() => {});
      rmSync(tokenPath, { force: true });
      rmSync(sentinelPath, { force: true });
      rmSync(healthPath, { force: true });
    } catch (shred) {
      // Material may be left behind, which outranks the failure that started the shred, and an
      // escaped error would bypass the refusal below.
      cause = shred as Error;
    }
    return fail(refusals?.bearer ?? `agent auth preflight failed for "${name}": ${cause.message}`);
  }
}

/** Foreground USER-MODE onboarding — the CLI-side twin of the manager's user spawn provisioning:
 *  owner = the logged-in operator (offline, from the login cache + local user-auth material);
 *  principal-keyed durables on an ephemeral provisioner (LIVE-ONLY, like static foreground);
 *  ledger grant with a fresh per-agent secret (upsert rotates); 0600 secret/sentinel files; and a
 *  one-shot bearer preflight whose operator-exact sentence is the refusal. Exits on any failure —
 *  the agent process is never launched into a broken auth chain. */
async function provisionUserForeground(
  target: MeshTarget,
  name: string,
  ref: string,
  opts: { subscribe?: string[]; allowSubscribe: string[]; allowPublish?: string[]; role?: string; capabilities?: string[]; lifecycleUid: string; liveOnly?: boolean; eventChannel?: (p: { owner: string; actor: string }) => string },
): Promise<{ userAuth: NonNullable<LaunchOpts["userAuth"]>; cleanup: () => Promise<void>; eventChannel?: string }> {
  const { space, server } = target;
  const dir = userAuthStateDir(target.root, space);
  const store = workspaceSecretStore(target.root);
  const composition = { injected: false as const, root: target.root };
  const fail = (msg: string): never => {
    console.error(c.red(`✗ ${msg}`));
    process.exit(1);
  };
  let provider: ReturnType<typeof resolveAuthProvider>;
  let owner: string;
  try {
    provider = resolveAuthProvider();
    owner = await provider.ownerForLogin({ store, dir, space });
  } catch (e) {
    return fail((e as Error).message);
  }
  // The provisioner cred is INFRA (pre-flip static coexistence, like the manager's own creds) —
  // loaded explicitly here for durable pre-creation only, never for the agent's identity.
  // The event grant, derived HERE because this is the first point at which the owner exists: in
  // user mode the principal is (resolved owner, actor name), and neither half is known to the
  // caller before `ownerForLogin` answers.
  const eventGrant = opts.eventChannel?.({ owner, actor: name });
  const publish = eventGrant ? [...(opts.allowPublish ?? []), eventGrant] : (opts.allowPublish ?? []);
  const infra = await getSpaceAuth(store, space); // cross-check the bundle names the space we resolved this root for
  if (!infra) return fail(`space "${space}" has user-auth state but no trust record under ${authDir(target.root)} (expected ${spaceAccountPath(authDir(target.root), space)} or the legacy auth.json) - re-run \`cotal up --user-auth\` here`);
  const { actorToken: tokenPath, sentinelCreds: sentinelPath, health: healthPath } = agentSecretFilePaths(target.root, space, name);
  try {
    // The GRANT first — it is the envelope-rule enforcement point (a delegation must sit within
    // the spawner's own grant), so a refused delegation exits here with zero broker footprint —
    // the same ordering as Manager.provisionUserAgent, for the same reason.
    const grant = await provider.grantAgent({
      store,
      dir,
      space,
      owner,
      actor: name,
      scope: (opts.capabilities ?? []).filter((s) => s === "spawn" || s === "run" || s === "admin" || /^role:[A-Za-z0-9_-]+$/.test(s)),
      allowSubscribe: opts.allowSubscribe,
      allowPublish: publish,
      role: opts.role,
      parent: `${owner}.cli`,
      label: ref,
      lifecycleUid: opts.lifecycleUid,
    });
    const prov = new CotalEndpoint({
      space,
      servers: server,
      creds: await mintCreds(infra, newIdentity(), "provisioner"),
      channels: [],
      consume: false,
      registerPresence: false,
      watchPresence: false,
      watchChannels: false,
      card: { name: "spawn-provisioner", role: "provisioner", kind: "endpoint" },
    });
    const reportUserProvisioner = (e: Error) => console.error(`! provisioner: ${e.message}`);
    prov.on("error", reportUserProvisioner);
    prov.on("warning", reportUserProvisioner);
    await prov.start();
    try {
      // Full durable footprint, same as the static foreground path: the ACL row is what lets the
      // delivery daemon authorize this agent's durable joins. `--live-only` opts out.
      await provisionAgentDurables(prov, { owner, actor: name, lifecycleUid: opts.lifecycleUid }, {
        subscribe: opts.subscribe,
        allowSubscribe: opts.allowSubscribe,
        role: opts.role,
        ...(opts.liveOnly ? { durableMembership: false } : {}),
      });
    } finally {
      await prov.stop();
    }
    // The store holds the source of truth; the bearer re-exec (`--token-file`) and the launch's
    // sentinel handoff read FILES — materialize both at the canonical paths (byte-identical
    // rewrites under this, the local FS, composition).
    await store.put(agentActorTokenKey(space, name, composition), grant.actorToken);
    await store.put(agentSentinelCredsKey(space, name, composition), grant.sentinelCreds);
    await materializeSecretToFile(store, agentActorTokenKey(space, name, composition), tokenPath);
    await materializeSecretToFile(store, agentSentinelCredsKey(space, name, composition), sentinelPath);
    rmSync(healthPath, { force: true });
    provenance.wrote(`actor grant ${owner}.${name} (user mode)`, tokenPath);
    const bearerCmd = [
      process.execPath,
      ...process.execArgv,
      process.argv[1],
      provider.agentBearerCommand,
      "--dir", dir,
      "--space", space,
      "--owner", owner,
      "--actor", name,
      "--token-file", tokenPath,
      "--health-file", healthPath,
    ];
    await runBearerPreflight(bearerCmd);
    return {
      userAuth: { owner, actor: name, sentinelCredsPath: sentinelPath, bearerCmd },
      ...(eventGrant ? { eventChannel: eventGrant } : {}),
      // The foreground departure's half of the runtime-grant invariant: the caller runs this when
      // the agent process exits — revoke the row, shred the secret material, and retire the broker
      // footprint the durable provisioning above created (DM/DLV durables + ACL row), the same
      // teardown the rollback path below runs on a failed preflight.
      cleanup: async () => {
        await provider.revokeAgent({ dir, owner, actor: name });
        await store.delete(agentActorTokenKey(space, name, composition));
        await store.delete(agentSentinelCredsKey(space, name, composition));
        rmSync(tokenPath, { force: true });
        rmSync(sentinelPath, { force: true });
        rmSync(healthPath, { force: true });
        const targetId = principalKey(owner, name).key;
        await mintCreds(infra, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid: opts.lifecycleUid } })
          .then((creds) => deprovisionAgent({ servers: server, space, targetId, lifecycleUid: opts.lifecycleUid, creds }))
          .catch((err) => console.error(c.red(`✗ retiring ${name}'s broker footprint: ${(err as Error).message}`)));
      },
    };
  } catch (e) {
    // Roll back EVERYTHING this attempt materialized, including the broker footprint the durable
    // provisioning above created — a refused spawn leaves no row, no secret, no orphaned durables.
    await provider.revokeAgent({ dir, owner, actor: name }).catch(() => {});
    await store.delete(agentActorTokenKey(space, name, composition)).catch(() => {});
    await store.delete(agentSentinelCredsKey(space, name, composition)).catch(() => {});
    rmSync(tokenPath, { force: true });
    rmSync(sentinelPath, { force: true });
    rmSync(healthPath, { force: true });
    const targetId = principalKey(owner, name).key;
    await mintCreds(infra, newIdentity(), "deprovisioner", { deprovisionTarget: { principal: targetId, lifecycleUid: opts.lifecycleUid } })
      .then((creds) => deprovisionAgent({ servers: server, space, targetId, lifecycleUid: opts.lifecycleUid, creds }))
      .catch((err) => console.error(c.red(`✗ rollback deprovision ${name}: ${(err as Error).message}`)));
    return fail(`agent auth preflight failed for "${name}": ${(e as Error).message}`);
  }
}

/** Run the one-shot bearer proof with an explicit credential-scrubbed environment. The enrollment
 * path removes the variables from the parent before any child, and this boundary independently
 * refuses to inherit them if another caller reaches it with ambient enrollment input. */
export async function runBearerPreflight(bearerCmd: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const childEnv = { ...env };
  scrubEnrollmentEnv(childEnv);
  const timeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    execFile(
      bearerCmd[0],
      bearerCmd.slice(1),
      { timeout, maxBuffer: 64 * 1024, env: childEnv },
      (err, _stdout, stderr) => err ? reject(bearerCommandFailure(err, stderr, timeout)) : resolve(),
    );
  });
}
