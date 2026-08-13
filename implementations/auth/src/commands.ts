/**
 * Self-registering `login` / `logout` commands (the delivery-daemon pattern): importing
 * `@cotal-ai/auth` registers them into the core `Registry`, and the `cotal` binary pulls the
 * package in at its composition root. Session state lives under the workspace's `homeCotalDir()`
 * (`~/.cotal`, `COTAL_HOME`-overridable) — per human, per machine, NOT per checkout: you are
 * logged in as YOU across every repo on this box.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { CotalEndpoint, mintCreds, newIdentity, registry, type Command, type ParsedArgs, type SecretStore } from "@cotal-ai/core";
import { CLI_USER_ACTOR, findCotalRoot, getSpaceAuth, homeCotalDir, loadMeshes, probeLiveness, resolveSpace, userAuthStateDir, workspaceSecretStore, type AgentAuthHealth } from "@cotal-ai/workspace";
import {
  deleteIdpSession,
  establishIdpSession,
  loadIdpSession,
  normalizeIdpUrl,
  revokeIdpSession,
} from "./login.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { findManagedActor, grantActor, loadActorLedger, revokeActor } from "./ledger.js";
import { runAuthService } from "./service.js";
import { loadAuthServiceInfo, loadOwnerSecret, loadPinnedIdp } from "./store.js";

const DEFAULT_CLIENT_ID = "cotal-cli";

/** Every operational failure in these commands is a deliberately-legible thrown sentence
 *  (a refused client id, a revoked session, a malformed IdP response …) — the CLI's generic
 *  catch would re-throw it into a raw stack trace. Print the sentence, exit 1. */
async function legibly(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

async function runLogin(args: ParsedArgs): Promise<void> {
  const values = args.values as { idp?: string; "client-id"?: string };
  if (!values.idp) {
    console.error("usage: cotal login --idp <auth base URL> [--client-id <id>]   (Better Auth: <origin>/api/auth)");
    process.exit(1);
  }
  const idpArg = values.idp;
  await legibly(async () => {
    const idp = normalizeIdpUrl(idpArg);
    // establishIdpSession proves the session mints user JWTs BEFORE persisting it — a failed
    // proof leaves no cache entry to fool requireIdpSession later.
    const { session, sub, label } = await establishIdpSession({
      dir: homeCotalDir(),
      idpUrl: idp,
      clientId: values["client-id"] ?? DEFAULT_CLIENT_ID,
      onPrompt: (p) => {
        console.log(`\nTo approve this sign-in, open:\n\n    ${p.verificationUriComplete}\n`);
        console.log(`(or go to ${p.verificationUri} and enter the code ${p.userCode})\n`);
        console.log(`Waiting for approval - the code expires in ${Math.ceil(p.expiresInSec / 60)} min. Ctrl-C to abort.`);
      },
    });
    // WHO signed in must be human-readable (per-user auth exists for operator-visible identity):
    // prefer the IdP's email/name claim; the raw `sub` stays as the stable id (dim when secondary).
    const who = label ? `${label} (${sub})` : sub;
    console.log(
      `\nLogged in to ${idp} as ${who}. Session cached in ${homeCotalDir()} until ${new Date(session.expiresAt * 1000).toISOString()}.`,
    );
    // Signing in proves WHO you are; each mesh separately lets you in. Hand the human the exact
    // next step — their sub is the one thing the operator needs from them.
    console.log(
      `Not yet on a mesh? Its operator lets you in with: cotal actor grant ${CLI_USER_ACTOR} --sub ${sub}   (that's the full grant - all channels, may spawn; narrow with --allow-subscribe/--allow-publish/--scope)`,
    );
  });
}

async function runLogout(args: ParsedArgs): Promise<void> {
  const values = args.values as { idp?: string };
  if (!values.idp) {
    console.error("usage: cotal logout --idp <auth base URL>");
    process.exit(1);
  }
  const idpArg = values.idp;
  await legibly(async () => {
    const idp = normalizeIdpUrl(idpArg);
    const dir = homeCotalDir();
    const session = loadIdpSession(dir, idp);
    if (!session) {
      console.log(`not logged in to ${idp} - nothing to clear`);
      return;
    }
    try {
      await revokeIdpSession(idp, session.token);
    } catch (e) {
      // KEEP the local session on a failed revoke: the cached token is the only handle that can
      // retry the revoke from the CLI, and a still-live server-side session that can no longer be
      // revoked is worse than a lingering local cache. Fail loud with the recourse; the operator
      // re-runs `cotal logout`.
      throw new Error(
        `could not revoke the server-side session at ${idp} (${e instanceof Error ? e.message : String(e)}). ` +
          `Your local login is kept so you can retry \`cotal logout --idp ${idp}\`; if it keeps failing, revoke the session from the IdP directly.`,
      );
    }
    deleteIdpSession(dir, idp);
    console.log(`Logged out of ${idp} - server-side session revoked, local cache cleared.`);
  });
}

/** The space-scoped provider state the `actor` commands operate on: the ledger dir
 *  (`userAuthStateDir` — the multi-space-ready layout; nothing user-auth lives flat in
 *  `.cotal/auth/`) plus the local secret store (these are workstation commands — the ledger
 *  machine — so the workspace FS composition IS the correct one, not a fallback). */
function actorState(space?: string): { dir: string; space: string; store: SecretStore } {
  const s = space ?? resolveSpace(process.cwd());
  const root = findCotalRoot();
  return { dir: userAuthStateDir(root, s), space: s, store: workspaceSecretStore(root) };
}

/** Resolve the operator's target (owner) for `actor grant`/`revoke`: an explicit derived `--owner`
 *  token, or `--sub` (the IdP subject `cotal login` prints) derived through the SAME frozen encoding
 *  the bridge exchange uses. BOTH require the space's owner secret + IdP pin under `dir` — i.e. this
 *  IS the machine that ran `cotal up --user-auth`, where the authoritative ledger lives. Without
 *  them a grant would write an INERT LOCAL row and print a misleading success while the mesh's real
 *  ledger is untouched (an off-machine `--owner` cannot mutate authority), so we refuse instead. */
async function resolveGrantOwner(
  st: { dir: string; space: string; store: SecretStore },
  values: { owner?: string; sub?: string },
): Promise<string> {
  if (values.owner && values.sub) throw new Error("pass --owner OR --sub, not both");
  if (!values.owner && !values.sub) throw new Error("say who: --sub <IdP subject> (shown by `cotal login`) or --owner <u_…>");
  const secret = await loadOwnerSecret(st.store, st.space);
  const idp = loadPinnedIdp(st.dir);
  if (!secret || !idp)
    throw new Error(
      `user auth is not enabled for this space here (no owner secret/IdP pin for "${st.space}"). The actor ledger lives on the machine that ran \`cotal up --user-auth --idp <url>\`; run the \`actor\` commands there`,
    );
  if (values.owner) return values.owner;
  return deriveOwnerForIdpSubject(secret, idp.issuer, values.sub!);
}

const csv = (s: string | undefined, dflt: string[]): string[] =>
  s === undefined ? dflt : s.split(",").map((x) => x.trim()).filter(Boolean);

/** Close a revoked principal's LIVE window (D5 acceptance gate: removal stops live delivery
 *  IMMEDIATELY, not at bearer expiry): mint an ephemeral supervisor cred from the local signer and
 *  request the delivery daemon's `evictPrincipal` (privileged delivery-admin rail — scan→KICK→
 *  verify). BEST-EFFORT with honest copy: deny-new is already committed by the ledger revoke
 *  before this runs, so a missing daemon/signer/registry only widens the end back to the bearer's
 *  own expiry — reported, never silent, and never a reason to fail the revoke. */
async function evictRevokedPrincipal(space: string, principal: string): Promise<string> {
  const fallback = (why: string) =>
    `live-connection eviction skipped (${why}) - deny-new is committed and the revoke cannot be re-run; the already-open connection ends at its current bearer's expiry. To evict live connections at revoke time, run \`cotal actor revoke\` from the mesh root (local signer + registry).`;
  const root = findCotalRoot();
  const auth = await getSpaceAuth(workspaceSecretStore(root), space);
  if (!auth) return fallback("no local signer here");
  const mesh = loadMeshes().find((m) => m.space === space);
  if (!mesh) return fallback("mesh not in the local registry");
  const id = newIdentity();
  const ep = new CotalEndpoint({
    space,
    servers: mesh.server,
    creds: await mintCreds(auth, id, "supervisor"),
    card: { id: id.id, name: "revoke-evict", kind: "endpoint" },
    channels: [],
    consume: false,
    watchChannels: false,
    watchPresence: false,
    registerPresence: false,
  });
  ep.on("error", () => {});
  try {
    await ep.start();
    const r = await ep.requestDeliveryAdmin("evictPrincipal", { principal }, 15_000);
    if (!r.ok) return `live-connection eviction refused: ${r.error}`;
    const d = (r.data ?? {}) as { kicked?: number; remaining?: number; verifiedGone?: boolean };
    return d.verifiedGone
      ? `live connections closed now (${d.kicked ?? 0} kicked, verified gone)`
      : `live-connection eviction INCOMPLETE (${d.kicked ?? 0} kicked, ${d.remaining ?? "?"} still live) - run \`cotal doctor auth\``;
  } catch (e) {
    return fallback(e instanceof Error ? e.message : String(e));
  } finally {
    await ep.stop().catch(() => {});
  }
}

async function runActor(args: ParsedArgs): Promise<void> {
  const [sub, actor] = args.positionals;
  const values = args.values as {
    space?: string; sub?: string; owner?: string; scope?: string; "allow-subscribe"?: string;
    "allow-publish"?: string; role?: string; label?: string; parent?: string;
  };
  const st = actorState(values.space);
  const { dir, space } = st;
  await legibly(async () => {
    if (sub === "list") {
      const rows = loadActorLedger(dir);
      if (!rows.length) {
        console.log("no actors granted - grant one with: cotal actor grant <actor> --sub <IdP subject>");
        return;
      }
      for (const r of rows.sort((a, b) => (a.owner + a.actor).localeCompare(b.owner + b.actor)))
        console.log(
          `${r.owner}.${r.actor}${r.label ? `  (${r.label})` : ""}  kind=${r.kind}  role=${r.role ?? "-"}  scope=[${r.scope.join(",")}]  read=[${r.allowSubscribe.join(",")}]  post=[${r.allowPublish.join(",")}]`,
        );
      return;
    }
    if (sub === "grant") {
      if (!actor) throw new Error("usage: cotal actor grant <actor> --sub <IdP subject> [--scope a,b] [--allow-subscribe a,b] [--allow-publish a,b] [--role r] [--label l]");
      const owner = await resolveGrantOwner(st, values);
      // Default = the FULL grant (all channels, spawn + the stock role): `actor grant` is an
      // operator act of letting a user in, so omitting flags means "fully", and narrowing is the
      // explicit choice (`--allow-subscribe general --scope ''`). The user's agents are still
      // attenuated from whatever this row says (the envelope rule).
      const row = grantActor(dir, {
        owner,
        actor,
        scope: csv(values.scope, ["spawn", "role:default"]),
        allowSubscribe: csv(values["allow-subscribe"], [">"]),
        allowPublish: csv(values["allow-publish"], [">"]),
        ...(values.role ? { role: values.role } : {}),
        ...(values.label ? { label: values.label } : {}),
        ...(values.parent ? { parent: values.parent } : {}),
      });
      console.log(`✓ granted ${row.owner}.${row.actor} - read [${row.allowSubscribe.join(", ")}], post [${row.allowPublish.join(", ")}]${row.scope.length ? `, scope [${row.scope.join(", ")}]` : ""}`);
      return;
    }
    if (sub === "revoke") {
      if (!actor) throw new Error("usage: cotal actor revoke <actor> --sub <IdP subject>|--owner <u_…>");
      const owner = await resolveGrantOwner(st, values);
      if (!revokeActor(dir, owner, actor)) {
        if (findManagedActor(dir, owner, actor))
          throw new Error(`${owner}.${actor} is a managed agent - its grant lives with its process: stop it if manager-owned (\`cotal stop --name ${actor}\`), or if it was a killed foreground spawn, respawn the same name (\`cotal spawn\`) to rotate the grant`);
        console.log(`no grant for ${owner}.${actor} - nothing to revoke`);
        return;
      }
      // Deny-new is immediate at both boundaries (exchange + connect). The LIVE window no longer
      // rides the bearer's expiry by default: the flip wires revoke → the delivery daemon's
      // evictPrincipal (scan→KICK→verify on the privileged rail), best-effort with honest copy —
      // a human bearer can otherwise carry up to the IdP session cap, far beyond the agents' TTL.
      console.log(`✓ revoked ${owner}.${actor} - new exchanges and new connects are denied now`);
      console.log(`  ${await evictRevokedPrincipal(space, `${owner}.${actor}`)}`);
      return;
    }
    throw new Error("usage: cotal actor <grant <actor> | revoke <actor> | list>");
  });
}

/** `cotal agent-bearer` — the ONE thing a spawned user-mode agent execs to refresh its auth: read
 *  its spawn-time secret from the 0600 token file, exchange it at the space's auth service (agent
 *  grant type), print the fresh bearer to STDOUT, exit. Machine-facing: stdout carries the bearer
 *  and NOTHING else; every failure is a stderr sentence + exit 1 (the endpoint surfaces it as a
 *  loud "error" event and retries). The secret rides a file, never argv (ps-visible) or env. */
async function runAgentBearer(args: ParsedArgs): Promise<void> {
  const v = args.values as {
    dir?: string; space?: string; owner?: string; actor?: string;
    "token-file"?: string; "health-file"?: string;
  };
  const { dir, space, owner, actor } = v;
  const tokenFile = v["token-file"];
  if (!dir || !space || !owner || !actor || !tokenFile)
    throw new Error("usage: cotal agent-bearer --dir <state-dir> --space <s> --owner <u_…> --actor <a> --token-file <path> [--health-file <path>]");
  // Every attempt's outcome lands in the manager-composed health file (core's AgentAuthHealth) —
  // the `ps` window into a detached agent's bearer life. Best-effort: health reporting must never
  // turn a successful exchange into a failure.
  const health = (state: "ok" | "failed", reason?: string) => {
    const path = v["health-file"];
    if (!path) return;
    try {
      writeFileSync(path, JSON.stringify({ state, at: new Date().toISOString(), ...(reason ? { reason } : {}) } satisfies AgentAuthHealth));
    } catch { /* the exchange outcome still stands */ }
  };
  try {
    let actorToken: string;
    try {
      actorToken = readFileSync(tokenFile, "utf8").trim();
    } catch (e) {
      throw new Error(`agent-bearer: can't read the actor token file at ${tokenFile} (${e instanceof Error ? e.message : String(e)}) - respawn this agent to re-provision it`);
    }
    const info = loadAuthServiceInfo(dir);
    // Proof required: only `alive` counts as running. The old two-state probe called EPERM dead, so
    // a service running as ANOTHER USER produced "not running - restart it with `cotal up`" about a
    // service that was up the whole time; the contract resolves EPERM to alive and fixes exactly
    // that. `unknown` still refuses, because telling an operator to talk to an endpoint whose
    // liveness cannot be established is worse than telling them to restart.
    if (!info || probeLiveness(info.pid) !== "alive")
      throw new Error(`agent-bearer: the user-auth service for space "${space}" is not running - restart it with \`cotal up\``);
    let res: Response;
    try {
      res = await fetch(`${info.url}/exchange`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${info.cap}` },
        body: JSON.stringify({ owner, actor, actorToken }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(`agent-bearer: the user-auth service did not answer at ${info.url} (${e instanceof Error ? e.message : String(e)}) - restart it with \`cotal up\``);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(`agent-bearer: exchange refused: ${body.error ?? `HTTP ${res.status}`}`);
    }
    const out = (await res.json().catch(() => ({}))) as { token?: string };
    if (typeof out.token !== "string" || !out.token)
      throw new Error("agent-bearer: the auth service's exchange returned no token - its build may be stale; restart it with `cotal up`");
    health("ok");
    process.stdout.write(`${out.token}\n`);
  } catch (e) {
    health("failed", e instanceof Error ? e.message : String(e));
    throw e;
  }
}

const authCommands: Command[] = [
  {
    kind: "command",
    name: "auth-service",
    group: "Manager",
    summary: "run the user-auth service daemon - NATS auth callout + token exchange/JWKS --space <s> --server <url> [--port <n>]",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space to serve (required)" },
      { name: "server", type: "string", value: "<url>", description: "broker URL the callout serves (required)" },
      { name: "port", type: "string", value: "<n>", description: "loopback HTTP port for /exchange + /jwks (default: ephemeral)" },
    ],
    run: (args) => legibly(() => runAuthService(args)),
  },
  {
    kind: "command",
    name: "actor",
    group: "Identity",
    summary: "manage the space's actor ledger - grant/revoke which (user, actor) pairs may run agents",
    usage: "actor <grant <actor> | revoke <actor> | list> [--sub <IdP subject>|--owner <u_…>] [--space <s>] [--scope a,b] [--allow-subscribe a,b] [--allow-publish a,b] [--role r] [--label l]",
    positionals: "<grant <actor> | revoke <actor> | list>",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space whose ledger to manage (default: the folder's)" },
      { name: "sub", type: "string", value: "<subject>", description: "the IdP subject (shown by `cotal login`) the actor belongs to" },
      { name: "owner", type: "string", value: "<u_…>", description: "the derived owner token (alternative to --sub)" },
      { name: "scope", type: "string", value: "<a,b>", description: "capability scope for the bearer (default: spawn,role:default; '' = none; spawn = may run agents, role:<r> = may delegate role r)" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "channel read ACL (default: > = all channels) - the user's envelope: their agents can never read beyond it" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "channel post ACL (default: > = all channels) - also the envelope for their agents' posting" },
      { name: "role", type: "string", value: "<r>", description: "role (scopes the task-queue consumer)" },
      { name: "label", type: "string", value: "<l>", description: "display label for `actor list` (never the IdP subject)" },
      { name: "parent", type: "string", value: "<owner.actor>", description: "spawning principal audit link (operator grants are authority - this does not attenuate)" },
    ],
    run: runActor,
  },
  {
    kind: "command",
    name: "agent-bearer",
    group: "Manager",
    summary: "print one fresh agent bearer for a spawned user-mode agent (machine-facing; exec'd by agent endpoints)",
    usage: "agent-bearer --dir <state-dir> --space <s> --owner <u_…> --actor <a> --token-file <path>",
    flags: [
      { name: "dir", type: "string", value: "<state-dir>", description: "the space's user-auth state dir" },
      { name: "space", type: "string", value: "<s>", description: "the space the bearer is scoped to" },
      { name: "owner", type: "string", value: "<u_…>", description: "the agent's owner token" },
      { name: "actor", type: "string", value: "<a>", description: "the agent's actor token" },
      { name: "token-file", type: "string", value: "<path>", description: "0600 file holding the spawn-time agent secret" },
      { name: "health-file", type: "string", value: "<path>", description: "write each attempt's outcome here (read by the manager's ps)" },
    ],
    run: (args) => legibly(() => runAgentBearer(args)),
  },
  {
    kind: "command",
    name: "login",
    group: "Identity",
    summary: "sign in to a space's IdP (device code) and cache the session --idp <auth base URL> [--client-id <id>]",
    usage: "login --idp <auth base URL> [--client-id <id>]",
    flags: [
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
      { name: "client-id", type: "string", value: "<id>", description: "OAuth device-flow client id" },
    ],
    run: runLogin,
  },
  {
    kind: "command",
    name: "logout",
    group: "Identity",
    summary: "revoke the IdP session and clear the cached login --idp <auth base URL>",
    usage: "logout --idp <auth base URL>",
    flags: [
      { name: "idp", type: "string", value: "<auth base URL>", description: "Auth base URL, e.g. <origin>/api/auth" },
    ],
    run: runLogout,
  },
];

registry.register(...authCommands);
