/**
 * Self-registering `login` / `logout` commands (the delivery-daemon pattern): importing
 * `@cotal-ai/auth` registers them into the core `Registry`, and the `cotal` binary pulls the
 * package in at its composition root. Session state lives under the workspace's `homeCotalDir()`
 * (`~/.cotal`, `COTAL_HOME`-overridable) — per human, per machine, NOT per checkout: you are
 * logged in as YOU across every repo on this box.
 */
import { registry, type Command, type ParsedArgs } from "@cotal-ai/core";
import { findCotalRoot, homeCotalDir, resolveSpace, userAuthStateDir } from "@cotal-ai/workspace";
import {
  deleteIdpSession,
  establishIdpSession,
  loadIdpSession,
  normalizeIdpUrl,
  revokeIdpSession,
} from "./login.js";
import { deriveOwnerForIdpSubject } from "./derive.js";
import { grantActor, loadActorLedger, revokeActor } from "./ledger.js";
import { runAuthService } from "./service.js";
import { loadOwnerSecret, loadPinnedIdp } from "./store.js";

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
        console.log(`Waiting for approval — the code expires in ${Math.ceil(p.expiresInSec / 60)} min. Ctrl-C to abort.`);
      },
    });
    // WHO signed in must be human-readable (per-user auth exists for operator-visible identity):
    // prefer the IdP's email/name claim; the raw `sub` stays as the stable id (dim when secondary).
    const who = label ? `${label} (${sub})` : sub;
    console.log(
      `\nLogged in to ${idp} as ${who}. Session cached in ${homeCotalDir()} until ${new Date(session.expiresAt * 1000).toISOString()}.`,
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
      console.log(`not logged in to ${idp} — nothing to clear`);
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
    console.log(`Logged out of ${idp} — server-side session revoked, local cache cleared.`);
  });
}

/** The space-scoped provider state dir the `actor` commands operate on (`userAuthStateDir` — the
 *  multi-space-ready layout; nothing user-auth lives flat in `.cotal/auth/`). */
function actorStateDir(space?: string): { dir: string; space: string } {
  const s = space ?? resolveSpace(process.cwd());
  return { dir: userAuthStateDir(findCotalRoot(), s), space: s };
}

/** Resolve the operator's target (owner) for `actor grant`/`revoke`: an explicit derived `--owner`
 *  token, or `--sub` (the IdP subject `cotal login` prints) derived through the SAME frozen encoding
 *  the bridge exchange uses. Grant-by-sub needs the space's owner secret + IdP pin — i.e. user auth
 *  already enabled here — and says exactly that when they're missing. */
function resolveGrantOwner(dir: string, values: { owner?: string; sub?: string }): string {
  if (values.owner && values.sub) throw new Error("pass --owner OR --sub, not both");
  if (values.owner) return values.owner;
  if (!values.sub) throw new Error("say who: --sub <IdP subject> (shown by `cotal login`) or --owner <u_…>");
  const secret = loadOwnerSecret(dir);
  const idp = loadPinnedIdp(dir);
  if (!secret || !idp)
    throw new Error(`user auth is not enabled for this space (no owner secret/IdP pin under ${dir}) — run \`cotal up --user-auth --idp <url>\` first`);
  return deriveOwnerForIdpSubject(secret, idp.issuer, values.sub);
}

const csv = (s: string | undefined, dflt: string[]): string[] =>
  s === undefined ? dflt : s.split(",").map((x) => x.trim()).filter(Boolean);

async function runActor(args: ParsedArgs): Promise<void> {
  const [sub, actor] = args.positionals;
  const values = args.values as {
    space?: string; sub?: string; owner?: string; scope?: string; "allow-subscribe"?: string;
    "allow-publish"?: string; role?: string; label?: string; parent?: string;
  };
  const { dir } = actorStateDir(values.space);
  await legibly(async () => {
    if (sub === "list") {
      const rows = loadActorLedger(dir);
      if (!rows.length) {
        console.log("no actors granted — grant one with: cotal actor grant <actor> --sub <IdP subject>");
        return;
      }
      for (const r of rows.sort((a, b) => (a.owner + a.actor).localeCompare(b.owner + b.actor)))
        console.log(
          `${r.owner}.${r.actor}${r.label ? `  (${r.label})` : ""}  role=${r.role ?? "-"}  scope=[${r.scope.join(",")}]  read=[${r.allowSubscribe.join(",")}]  post=[${r.allowPublish.join(",")}]`,
        );
      return;
    }
    if (sub === "grant") {
      if (!actor) throw new Error("usage: cotal actor grant <actor> --sub <IdP subject> [--scope a,b] [--allow-subscribe a,b] [--allow-publish a,b] [--role r] [--label l]");
      const owner = resolveGrantOwner(dir, values);
      const row = grantActor(dir, {
        owner,
        actor,
        scope: csv(values.scope, []),
        allowSubscribe: csv(values["allow-subscribe"], ["general"]),
        allowPublish: csv(values["allow-publish"], ["general"]),
        ...(values.role ? { role: values.role } : {}),
        ...(values.label ? { label: values.label } : {}),
        ...(values.parent ? { parent: values.parent } : {}),
      });
      console.log(`✓ granted ${row.owner}.${row.actor} — read [${row.allowSubscribe.join(", ")}], post [${row.allowPublish.join(", ")}]${row.scope.length ? `, scope [${row.scope.join(", ")}]` : ""}`);
      return;
    }
    if (sub === "revoke") {
      if (!actor) throw new Error("usage: cotal actor revoke <actor> --sub <IdP subject>|--owner <u_…>");
      const owner = resolveGrantOwner(dir, values);
      if (!revokeActor(dir, owner, actor)) {
        console.log(`no grant for ${owner}.${actor} — nothing to revoke`);
        return;
      }
      console.log(`✓ revoked ${owner}.${actor} — new logins/connects are denied now; a live connection ends at its bearer expiry`);
      return;
    }
    throw new Error("usage: cotal actor <grant <actor> | revoke <actor> | list>");
  });
}

const authCommands: Command[] = [
  {
    kind: "command",
    name: "auth-service",
    group: "Manager",
    summary: "run the user-auth service daemon — NATS auth callout + token exchange/JWKS --space <s> --server <url> [--port <n>]",
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
    summary: "manage the space's actor ledger — grant/revoke which (user, actor) pairs may run agents",
    usage: "actor <grant <actor> | revoke <actor> | list> [--sub <IdP subject>|--owner <u_…>] [--space <s>] [--scope a,b] [--allow-subscribe a,b] [--allow-publish a,b] [--role r] [--label l]",
    positionals: "<grant <actor> | revoke <actor> | list>",
    flags: [
      { name: "space", type: "string", value: "<s>", description: "space whose ledger to manage (default: the folder's)" },
      { name: "sub", type: "string", value: "<subject>", description: "the IdP subject (shown by `cotal login`) the actor belongs to" },
      { name: "owner", type: "string", value: "<u_…>", description: "the derived owner token (alternative to --sub)" },
      { name: "scope", type: "string", value: "<a,b>", description: "capability scope for the bearer (default: none)" },
      { name: "allow-subscribe", type: "string", value: "<a,b>", description: "channel read ACL (default: general)" },
      { name: "allow-publish", type: "string", value: "<a,b>", description: "channel post ACL (default: general)" },
      { name: "role", type: "string", value: "<r>", description: "role (scopes the task-queue consumer)" },
      { name: "label", type: "string", value: "<l>", description: "display label for `actor list` (never the IdP subject)" },
      { name: "parent", type: "string", value: "<owner.actor>", description: "spawning principal audit link" },
    ],
    run: runActor,
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
